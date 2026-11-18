/**
 * PRD §6.1 / §12 / MVP phase 5: the public platform-stats widget must count
 * only posts a reader can reach. Soft-deleted (moderated) posts and
 * scheduled posts whose timestamp has not arrived are invisible everywhere
 * else — GET /api/embed/post/[id] 404s on both — so counting them in
 * `totalHoots` reports content the product does not show.
 *
 * Uses the real route and PostgreSQL. Only the server-only environment
 * marker is stubbed.
 *
 * Fixture ownership follows the receipts pattern from
 * a2a-feed-pagination.integration.test.ts: proposed ids never authorize
 * teardown. Every insert publishes its id from INSERT RETURNING only after
 * the statement commits, and cleanup runs child-first inside one transaction
 * under FOR UPDATE locks, refusing any row whose receipt no longer matches
 * this fixture or any user row that still authors a post.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/stats/route';

const owned = { users: [] as string[], posts: [] as string[] };
let authorId: string;
let visibleId: string;
let deletedId: string;
let futureId: string;
// Platform total observed before this suite inserts anything, so assertions
// hold whatever other rows the shared database already contains.
let baseline: number;

interface StatsBody {
  success: boolean;
  stats: { totalHoots: number };
}

async function readTotalHoots(): Promise<number> {
  const response = await GET(
    new NextRequest('http://localhost/api/feed/widgets/stats')
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as StatsBody;
  expect(body.success).toBe(true);
  expect(Number.isInteger(body.stats.totalHoots)).toBe(true);
  return body.stats.totalHoots;
}

beforeAll(async () => {
  const generated = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  authorId = generated[0]!;
  visibleId = generated[1]!;
  deletedId = generated[2]!;
  futureId = generated[3]!;

  const now = new Date();
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  baseline = await readTotalHoots();

  const [userRow] = await db
    .insert(users)
    .values({
      id: authorId,
      username: `sth${authorId}`,
      displayName: 'Stats hoots fixture',
      isTest: false,
      updatedAt: now,
    })
    .returning({ id: users.id });
  if (!userRow) throw new Error('Stats fixture user insert returned no row');
  owned.users.push(userRow.id);

  const postRows = await db
    .insert(posts)
    .values([
      {
        id: visibleId,
        content: 'Stats hoots fixture (visible)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: null,
      },
      {
        id: deletedId,
        content: 'Stats hoots fixture (moderated)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: past,
      },
      {
        id: futureId,
        content: 'Stats hoots fixture (scheduled)',
        authorId,
        timestamp: future,
        createdAt: past,
        deletedAt: null,
      },
    ])
    .returning({ id: posts.id });
  if (postRows.length !== 3) {
    throw new Error('Stats fixture post insert returned an incomplete receipt');
  }
  owned.posts.push(...postRows.map((row) => row.id));
});

// Child-first, transactional, guarded: lock the receipts, delete only rows
// this suite committed, and refuse if anything foreign remains. The tests
// deliberately mutate timestamp/deletedAt, so the user guard checks identity
// (username marker + no remaining authored post), not full-row equality.
async function deleteOwnedRows(): Promise<void> {
  if (owned.posts.length === 0 && owned.users.length === 0) return;
  await db.transaction(async (tx) => {
    if (owned.posts.length > 0) {
      await tx
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, owned.posts))
        .for('update');
    }
    if (owned.users.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, owned.users))
        .for('update');
    }

    if (owned.posts.length > 0) {
      const removedPosts = await tx
        .delete(posts)
        .where(
          and(inArray(posts.id, owned.posts), eq(posts.authorId, authorId))
        )
        .returning({ id: posts.id });
      if (removedPosts.length !== owned.posts.length) {
        throw new Error('Stats fixture cleanup refused Post');
      }
    }

    if (owned.users.length > 0) {
      const remaining = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.authorId, authorId));
      if (remaining.length > 0) {
        throw new Error(
          'Stats fixture cleanup refused User: foreign Post child'
        );
      }
      const removedUsers = await tx
        .delete(users)
        .where(
          and(
            inArray(users.id, owned.users),
            eq(users.username, `sth${authorId}`)
          )
        )
        .returning({ id: users.id });
      if (removedUsers.length !== owned.users.length) {
        throw new Error('Stats fixture cleanup refused User');
      }
    }
  });
  owned.posts.length = 0;
  owned.users.length = 0;
}

afterAll(async () => {
  await deleteOwnedRows();
});

describe('Platform stats count only reachable posts', () => {
  it('adds only the reachable fixture post to the platform total', async () => {
    // One reachable row was inserted; the moderated and scheduled rows must
    // not move the number. A total that counted all three would read
    // baseline + 3 here.
    expect(await readTotalHoots()).toBe(baseline + 1);
  });

  it('still moves for content readers can see', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000);
    const [extraRow] = await db
      .insert(posts)
      .values({
        id: await generateSnowflakeId(),
        content: 'Stats hoots fixture (extra visible)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: null,
      })
      .returning({ id: posts.id });
    if (!extraRow) {
      throw new Error('Stats fixture extra post insert returned no row');
    }
    owned.posts.push(extraRow.id);
    try {
      expect(await readTotalHoots()).toBe(baseline + 2);
    } finally {
      const removed = await db
        .delete(posts)
        .where(eq(posts.id, extraRow.id))
        .returning({ id: posts.id });
      if (removed.length !== 1) {
        throw new Error('Stats fixture cleanup refused extra Post');
      }
      owned.posts.splice(owned.posts.indexOf(extraRow.id), 1);
    }
    expect(await readTotalHoots()).toBe(baseline + 1);
  });

  it('follows moderation: publishing a scheduled post raises the total, removing one lowers it', async () => {
    const now = new Date();
    const before = await readTotalHoots();
    expect(before).toBe(baseline + 1);

    // A scheduled post becomes reachable once its timestamp arrives.
    await db
      .update(posts)
      .set({ timestamp: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(posts.id, futureId));
    expect(await readTotalHoots()).toBe(before + 1);

    // Moderating a visible post takes it out of the total.
    await db
      .update(posts)
      .set({ deletedAt: now })
      .where(eq(posts.id, visibleId));
    expect(await readTotalHoots()).toBe(before);

    // Restoring it brings it back.
    await db
      .update(posts)
      .set({ deletedAt: null })
      .where(eq(posts.id, visibleId));
    expect(await readTotalHoots()).toBe(before + 1);
  });
});
