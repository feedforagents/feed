/**
 * PRD §6.1 / §12 / MVP phase 5: the public platform-stats widget must count
 * only posts a reader can reach. Soft-deleted (moderated) posts and
 * scheduled posts whose timestamp has not arrived are invisible everywhere
 * else — GET /api/embed/post/[id] 404s on both — so counting them in
 * `totalHoots` reports content the product does not show.
 *
 * Uses the real route and PostgreSQL. Only the server-only environment
 * marker is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/stats/route';

const userIds: string[] = [];
const postIds: string[] = [];
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
  userIds.push(authorId);
  postIds.push(visibleId, deletedId, futureId);

  const now = new Date();
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  baseline = await readTotalHoots();

  await db.insert(users).values({
    id: authorId,
    username: `sth${authorId}`,
    displayName: 'Stats hoots fixture',
    isTest: false,
    updatedAt: now,
  });

  await db.insert(posts).values([
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
  ]);
});

afterAll(async () => {
  if (postIds.length) await db.delete(posts).where(inArray(posts.id, postIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

describe('Platform stats count only reachable posts', () => {
  it('adds only the reachable fixture post to the platform total', async () => {
    // One reachable row was inserted; the moderated and scheduled rows must
    // not move the number. A total that counted all three would read
    // baseline + 3 here.
    expect(await readTotalHoots()).toBe(baseline + 1);
  });

  it('still moves for content readers can see', async () => {
    const extraId = await generateSnowflakeId();
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000);
    await db.insert(posts).values({
      id: extraId,
      content: 'Stats hoots fixture (extra visible)',
      authorId,
      timestamp: past,
      createdAt: past,
      deletedAt: null,
    });
    postIds.push(extraId);
    try {
      expect(await readTotalHoots()).toBe(baseline + 2);
    } finally {
      await db.delete(posts).where(eq(posts.id, extraId));
      postIds.splice(postIds.indexOf(extraId), 1);
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
