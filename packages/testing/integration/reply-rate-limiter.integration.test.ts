import { afterAll, describe, expect, it } from 'bun:test';
import {
  comments,
  dbWrite,
  eq,
  inArray,
  sql,
  type Transaction,
  userInteractions,
} from '@feed/db';
import { ReplyRateLimiter } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const userIds: string[] = [];

async function pair() {
  const userId = await generateSnowflakeId();
  const npcId = await generateSnowflakeId();
  userIds.push(userId);
  return { userId, npcId, postId: `${npcId}-post` };
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
  if (userIds.length) {
    await dbWrite
      .delete(userInteractions)
      .where(inArray(userInteractions.userId, userIds));
    await dbWrite.delete(comments).where(inArray(comments.authorId, userIds));
  }
});

describe('ReplyRateLimiter.claimReply with real Postgres', () => {
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

    // Hold the per-(user, NPC) lock so both claims are in flight at once.
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`reply-rate:${userId}:${npcId}`}))`
      );
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pending = Promise.all([
      ReplyRateLimiter.claimReply(userId, npcId, writeComment(userId, postId)),
      ReplyRateLimiter.claimReply(userId, npcId, writeComment(userId, postId)),
    ]);
    const until = Date.now() + 3000;
    let waiting = 0;
    while (waiting < 2 && Date.now() < until) {
      const rows = await dbWrite.execute(
        sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'`
      );
      waiting = Number(rows[0]?.count ?? 0);
      if (waiting < 2) await Bun.sleep(10);
    }
    expect(waiting).toBe(2);
    release.resolve();
    await blocker;

    const results = await pending;
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    const rejected = results.find((r) => !r.allowed);
    expect(rejected?.rateLimit.minutesUntilNextReply).toBe(55);
    expect(await counts(userId)).toEqual({ interactions: 1, comments: 1 });
  });

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
});
