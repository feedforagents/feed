/**
 * Challenge progress for post challenges must count only posts that still
 * exist. The post resolvers (`daily_post`, `weekly_post` in
 * achievement-service.ts) counted soft-deleted posts, while every sibling
 * comment resolver (`daily_comment`, `weekly_comment`, and the comment half
 * of `weekly_feed_engage`) filters `deletedAt` out.
 *
 * Scenario, driven through the real surfaces against a real database:
 * a user writes 3 posts this week, deletes 2 of them through the real
 * DELETE /api/posts/[id] route (which soft-deletes by stamping
 * `posts.deletedAt`), and the rewards-page challenges must then show —
 * and award — progress for the 1 surviving post only:
 *
 * - `GET`-side display (`getUserChallenges`): "Content Creator"
 *   (weekly_three_posts, threshold 3) shows 1, not 3; "Share Your Take"
 *   (daily_create_post, threshold 1) shows 0 for a user whose only posts
 *   today were deleted, not a full bar.
 * - Completion (`checkProgress` on a later post_created event): one more
 *   live post brings the live total to 2, so the weekly challenge must
 *   NOT complete and must NOT pay its 150 points. On base it completed
 *   and paid, because the deleted posts still counted.
 * - Guard: 3 live posts still complete the weekly challenge and pay 150.
 *
 * The challenge rotation is deterministic: on 2026-11-15 (ISO week
 * 2026-W46) both `daily_create_post` and `weekly_three_posts` are active,
 * so the system clock is pinned there. Post timestamps are set explicitly
 * inside that day/week. Auth for the delete route uses the documented
 * non-production `x-dev-user-id` header. The only stub is the
 * `server-only` marker package.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';

mock.module('server-only', () => ({}));

import {
  checkProgress,
  getActiveDailyChallengeIds,
  getActiveWeeklyChallengeIds,
  getUserChallenges,
} from '@feed/api';
import {
  and,
  db,
  eq,
  inArray,
  notifications,
  pointsTransactions,
  posts,
  userAchievements,
  userChallengeProgress,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const PINNED_NOW = new Date('2026-11-15T12:00:00.000Z');
const POST_TIME = new Date('2026-11-15T08:00:00.000Z');
const WEEKLY_PERIOD = '2026-W46';

let deletePost: typeof import('../../../apps/web/src/app/api/posts/[id]/route').DELETE;

let userA: string; // 3 posts, 2 deleted, then 1 more live post
let userB: string; // guard: 3 live posts
let userC: string; // only deleted posts today
const allUsers: string[] = [];
const allPosts: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const id = await generateSnowflakeId();
  allUsers.push(id);
  await db.insert(users).values({
    id,
    username: `f58-${tag}-${id.slice(-8)}`,
    displayName: `F58 ${tag}`,
    isActor: false,
    reputationPoints: 0,
    updatedAt: new Date(),
  });
  return id;
}

async function makePost(authorId: string): Promise<string> {
  const id = await generateSnowflakeId();
  allPosts.push(id);
  await db.insert(posts).values({
    id,
    content: `f58 fixture post ${id.slice(-6)}`,
    authorId,
    timestamp: POST_TIME,
    createdAt: POST_TIME,
  });
  return id;
}

async function deleteViaRoute(userId: string, postId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}`, { method: 'DELETE' }),
    { headers: { 'x-dev-user-id': userId } }
  );
  const response = await deletePost(request, {
    params: Promise.resolve({ id: postId }),
  });
  return response.status;
}

async function weeklyRow(userId: string) {
  const rows = await db
    .select()
    .from(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        eq(userChallengeProgress.challengeId, 'weekly_three_posts'),
        eq(userChallengeProgress.periodKey, WEEKLY_PERIOD)
      )
    );
  return rows[0];
}

describe('challenge post counting', () => {
  beforeAll(async () => {
    setSystemTime(PINNED_NOW);
    // Rotation guards: the pinned date must activate both post challenges.
    expect(getActiveWeeklyChallengeIds()).toContain('weekly_three_posts');
    expect(getActiveDailyChallengeIds()).toContain('daily_create_post');

    ({ DELETE: deletePost } = await import(
      '../../../apps/web/src/app/api/posts/[id]/route'
    ));

    userA = await makeUser('a');
    userB = await makeUser('b');
    userC = await makeUser('c');
  });

  afterAll(async () => {
    // Notifications too: with the clock pinned, snowflake ids repeat
    // across runs, so a leaked notification row would collide on rerun.
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, allUsers));
    await db.delete(posts).where(inArray(posts.id, allPosts));
    await db
      .delete(userChallengeProgress)
      .where(inArray(userChallengeProgress.userId, allUsers));
    await db
      .delete(userAchievements)
      .where(inArray(userAchievements.userId, allUsers));
    await db
      .delete(pointsTransactions)
      .where(inArray(pointsTransactions.userId, allUsers));
    await db.delete(users).where(inArray(users.id, allUsers));
    setSystemTime();
  });

  it('shows only surviving posts as challenge progress after deletes', async () => {
    const p1 = await makePost(userA);
    const p2 = await makePost(userA);
    await makePost(userA); // the one surviving post

    expect(await deleteViaRoute(userA, p1)).toBe(200);
    expect(await deleteViaRoute(userA, p2)).toBe(200);

    // The rows really are soft-deleted, not gone.
    const deleted = await db
      .select({ id: posts.id, deletedAt: posts.deletedAt })
      .from(posts)
      .where(inArray(posts.id, [p1, p2]));
    expect(deleted).toHaveLength(2);
    expect(deleted.every((r) => r.deletedAt !== null)).toBe(true);

    const challenges = await getUserChallenges(userA);
    const weekly = challenges.weekly.challenges.find(
      (c) => c.id === 'weekly_three_posts'
    );
    expect(weekly).toBeDefined();
    expect(weekly?.threshold).toBe(3);
    // 1 live post of 3 written: base counts the 2 deleted ones too (3).
    expect(weekly?.progress).toBe(1);
    expect(weekly?.completed).toBe(false);
  });

  it('shows zero daily progress when the only posts today were deleted', async () => {
    const p1 = await makePost(userC);
    const p2 = await makePost(userC);
    expect(await deleteViaRoute(userC, p1)).toBe(200);
    expect(await deleteViaRoute(userC, p2)).toBe(200);

    const challenges = await getUserChallenges(userC);
    const daily = challenges.daily.challenges.find(
      (c) => c.id === 'daily_create_post'
    );
    expect(daily).toBeDefined();
    // Nothing the user wrote today still exists: base shows a full 1/1.
    expect(daily?.progress).toBe(0);
    expect(daily?.completed).toBe(false);
  });

  it('does not complete or pay the weekly challenge on deleted posts', async () => {
    // User A now writes one more live post (live total: 2 of threshold 3)
    // and the post_created progress check runs, as it does in production.
    await makePost(userA);
    await checkProgress(userA, { type: 'post_created' }, { failOnError: true });

    const row = await weeklyRow(userA);
    // Base completed here (count 4 incl. deleted) and awarded 150 points.
    expect(row?.completed ?? 0).toBe(0);
    expect(row?.pointsAwarded ?? 0).toBe(0);

    const challengeAwards = (
      await db
        .select({ metadata: pointsTransactions.metadata })
        .from(pointsTransactions)
        .where(
          and(
            eq(pointsTransactions.userId, userA),
            eq(pointsTransactions.reason, 'challenge_complete')
          )
        )
    ).filter((r) => r.metadata?.includes('weekly_three_posts'));
    expect(challengeAwards).toHaveLength(0);
  });

  it('still completes and pays when 3 posts genuinely survive', async () => {
    await makePost(userB);
    await makePost(userB);
    await makePost(userB);
    await checkProgress(userB, { type: 'post_created' }, { failOnError: true });

    const row = await weeklyRow(userB);
    expect(row?.completed).toBe(1);
    expect(row?.pointsAwarded).toBe(150);
  });
});
