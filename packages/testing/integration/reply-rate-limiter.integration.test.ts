import { afterAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  closeDatabase,
  comments,
  dbWrite,
  eq,
  inArray,
  type Transaction,
  userInteractions,
  users,
} from '@feed/db';
import { ReplyRateLimiter } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';

// Observer/blocker connections must not compete with the two application
// workers for a small pool. Keep their queries and idle transaction bounded.
const databaseUrl = process.env.DATABASE_URL ?? '';
const parsedDatabase = new URL(databaseUrl);
expect(['localhost', '127.0.0.1', '[::1]']).toContain(parsedDatabase.hostname);
expect(parsedDatabase.pathname).toMatch(/^\/(test_db|feed_pr\d+)$/);
const control = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 2,
  connection: {
    statement_timeout: 1000,
    lock_timeout: 1000,
    idle_in_transaction_session_timeout: 6000,
  },
});

const userIds: string[] = [];

async function acquireUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = userIds
) {
  const inserted = await dbWrite
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  ownership.push(...inserted.map((row) => row.id));
}

async function pair() {
  const userId = crypto.randomUUID();
  const npcId = crypto.randomUUID();
  await acquireUsers([
    { id: userId, username: `reply-rate-${userId}`, updatedAt: new Date() },
  ]);
  return { userId, npcId, postId: `${npcId}-post` };
}

async function contend(
  fixture: Awaited<ReturnType<typeof pair>>,
  failObservation = false
) {
  const { userId, npcId, postId } = fixture;
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const blocker = control.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `reply-rate:${userId}:${npcId}`,
    ]);
    const [backend] = await tx.unsafe<{ pid: number }[]>(
      'SELECT pg_backend_pid() AS pid'
    );
    if (!backend) throw new Error('Missing blocker backend');
    locked.resolve(backend.pid);
    await release.promise;
  });
  // A setup error must reject readiness rather than leave it pending.
  void blocker.catch(locked.reject);
  const claims: Array<ReturnType<typeof ReplyRateLimiter.claimReply>> = [];
  let workerPids: number[] = [];
  try {
    const blockerPid = await locked.promise;
    claims.push(
      ReplyRateLimiter.claimReply(userId, npcId, writeComment(userId, postId)),
      ReplyRateLimiter.claimReply(userId, npcId, writeComment(userId, postId))
    );
    // Consume failures immediately while observation is in progress; finally
    // still awaits the original promises before any fixture cleanup.
    for (const claim of claims) void claim.catch(() => {});
    const until = performance.now() + 3000;
    while (workerPids.length < 2 && performance.now() < until) {
      const rows = await control<{ pid: number }[]>`
        SELECT waiting.pid FROM pg_locks waiting
        JOIN pg_locks held ON held.pid = ${blockerPid}
          AND held.locktype = 'advisory' AND held.granted
          AND waiting.database = held.database
          AND waiting.classid = held.classid
          AND waiting.objid = held.objid
          AND waiting.objsubid = held.objsubid
        WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
      `;
      workerPids = rows.map((row) => row.pid);
      if (workerPids.length < 2) await Bun.sleep(10);
    }
    expect(workerPids).toHaveLength(2);
    if (failObservation) throw new Error('Injected observer failure');
    release.resolve();
    await blocker;
    return await Promise.all(claims);
  } finally {
    release.resolve();
    const drained = await Promise.allSettled([blocker, ...claims]);
    for (const outcome of drained) expect(outcome.status).toBe('fulfilled');
    if (workerPids.length) {
      const [remaining] = await control<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE pid = ANY(${workerPids})
          AND (wait_event = 'advisory' OR state = 'idle in transaction')
      `;
      expect(remaining?.count).toBe(0);
    }
  }
}

function writeComment(userId: string, postId: string) {
  return async (tx: Transaction) => {
    const now = new Date();
    const [comment] = await tx
      .insert(comments)
      .values({
        id: await generateSnowflakeId(),
        content: 'reply',
        postId,
        authorId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!comment) throw new Error('comment insert returned no row');
    return { postId, commentId: comment.id, qualityScore: 0.9 };
  };
}

async function counts(userId: string) {
  const interactions = await dbWrite
    .select({ id: userInteractions.id })
    .from(userInteractions)
    .where(eq(userInteractions.userId, userId));
  const written = await dbWrite
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.authorId, userId));
  return { interactions: interactions.length, comments: written.length };
}

afterAll(async () => {
  try {
    if (userIds.length) {
      await dbWrite
        .delete(userInteractions)
        .where(inArray(userInteractions.userId, userIds));
      await dbWrite.delete(comments).where(inArray(comments.authorId, userIds));
      for (const userId of userIds)
        expect(await counts(userId)).toEqual({ interactions: 0, comments: 0 });
      await dbWrite.delete(users).where(inArray(users.id, userIds));
      expect(
        await dbWrite
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, userIds))
      ).toHaveLength(0);
    }
  } finally {
    await Promise.all([control.end({ timeout: 2 }), closeDatabase()]);
  }
});

describe('ReplyRateLimiter.claimReply with real Postgres', () => {
  it('does not acquire cleanup ownership after an atomic setup failure', async () => {
    const existing = await pair();
    const freshId = crypto.randomUUID();
    const pendingOwnership: string[] = [];
    await assert.rejects(
      acquireUsers(
        [
          { id: freshId, updatedAt: new Date() },
          { id: existing.userId, updatedAt: new Date() },
        ],
        pendingOwnership
      ),
      (error: Error) => {
        const cause = 'cause' in error ? error.cause : error;
        return (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === '23505'
        );
      }
    );
    expect(pendingOwnership).toHaveLength(0);
    expect(
      await dbWrite
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, freshId))
    ).toHaveLength(0);
    const stored = await dbWrite
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, existing.userId));
    expect(stored).toEqual([{ username: `reply-rate-${existing.userId}` }]);
  });

  it('lets exactly one of two concurrent replies to the same NPC through', async () => {
    const { userId, npcId, postId } = await pair();

    // Both requests pass the read-only pre-check, as two concurrent route
    // calls do today.
    const [preA, preB] = await Promise.all([
      ReplyRateLimiter.canReply(userId, npcId),
      ReplyRateLimiter.canReply(userId, npcId),
    ]);
    expect(preA.allowed).toBe(true);
    expect(preB.allowed).toBe(true);

    const results = await contend({ userId, npcId, postId });
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    const rejected = results.find((r) => !r.allowed);
    expect(rejected?.rateLimit.minutesUntilNextReply).toBe(55);
    expect(await counts(userId)).toEqual({ interactions: 1, comments: 1 });
  }, 15000);

  it('releases and drains both claims after an observer failure', async () => {
    const fixture = await pair();
    const started = performance.now();
    await expect(contend(fixture, true)).rejects.toThrow(
      'Injected observer failure'
    );
    expect(performance.now() - started).toBeLessThan(6000);
    expect(await counts(fixture.userId)).toEqual({
      interactions: 1,
      comments: 1,
    });
  }, 15000);

  it('records nothing when the reply write fails', async () => {
    const { userId, npcId, postId } = await pair();

    await expect(
      ReplyRateLimiter.claimReply(userId, npcId, async (tx) => {
        await writeComment(userId, postId)(tx);
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect(await counts(userId)).toEqual({ interactions: 0, comments: 0 });

    const retry = await ReplyRateLimiter.claimReply(
      userId,
      npcId,
      writeComment(userId, postId)
    );
    expect(retry.allowed).toBe(true);
    expect(await counts(userId)).toEqual({ interactions: 1, comments: 1 });
  });

  it('still allows replies to a different NPC', async () => {
    const { userId, npcId, postId } = await pair();
    const otherNpc = await generateSnowflakeId();

    const first = await ReplyRateLimiter.claimReply(
      userId,
      npcId,
      writeComment(userId, postId)
    );
    const other = await ReplyRateLimiter.claimReply(
      userId,
      otherNpc,
      writeComment(userId, `${otherNpc}-post`)
    );
    const again = await ReplyRateLimiter.claimReply(
      userId,
      npcId,
      writeComment(userId, postId)
    );

    expect(first.allowed).toBe(true);
    expect(other.allowed).toBe(true);
    expect(again.allowed).toBe(false);
    expect(await counts(userId)).toEqual({ interactions: 2, comments: 2 });
  });

  it('rejects a 54-minute reply and allows one after 55 minutes', async () => {
    const { userId, npcId, postId } = await pair();
    const interactionId = crypto.randomUUID();
    await dbWrite.insert(userInteractions).values({
      id: interactionId,
      userId,
      npcId,
      postId,
      commentId: crypto.randomUUID(),
      timestamp: new Date(Date.now() - 54 * 60 * 1000),
    });
    const early = await ReplyRateLimiter.claimReply(
      userId,
      npcId,
      writeComment(userId, postId)
    );
    expect(early.allowed).toBe(false);
    expect(await counts(userId)).toEqual({ interactions: 1, comments: 0 });
    await dbWrite
      .update(userInteractions)
      .set({ timestamp: new Date(Date.now() - 55 * 60 * 1000) })
      .where(eq(userInteractions.id, interactionId));
    const allowed = await ReplyRateLimiter.claimReply(
      userId,
      npcId,
      writeComment(userId, postId)
    );
    expect(allowed.allowed).toBe(true);
    expect(await counts(userId)).toEqual({ interactions: 2, comments: 1 });
  });
});
