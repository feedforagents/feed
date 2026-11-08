/**
 * Profile post count against a real database: the post count shown in a
 * user's profile header (GET /api/users/[userId]/profile -> stats.posts)
 * must match the posts the profile list can actually show for that user.
 *
 * The list side is DatabaseService.getPostsByActor (what
 * GET /api/posts?actorId= delegates to): it returns only posts that are
 * not soft-deleted and whose timestamp has already arrived. The actor
 * (NPC) stats route applies the same two filters to its post count, with
 * the note that future-scheduled posts "must not be counted or hinted
 * at". The user profile stats counter must agree with the list on the
 * same profile screen.
 *
 * Nothing is mocked: the route and the list query run against the real
 * database. Fixture rows and cache entries are owned and removed after
 * the run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { invalidateCache } from '@feed/api';
import { db, getDbInstance, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getProfile } from '../../../apps/web/src/app/api/users/[userId]/profile/route';

const VISIBLE_POSTS = 3;
const EXPECTED_POSTS = VISIBLE_POSTS;

let targetId: string;
let otherId: string;
const postIds: string[] = [];

beforeAll(async () => {
  const runId = await generateSnowflakeId();
  targetId = await generateSnowflakeId();
  otherId = await generateSnowflakeId();
  const now = new Date();
  const hourMs = 60 * 60 * 1000;

  await db.insert(users).values([
    {
      id: targetId,
      username: `tpp-${runId.slice(-12)}`,
      displayName: 'Profile Post Count Fixture',
      updatedAt: now,
    },
    {
      id: otherId,
      username: `tpp-${runId.slice(-12)}-other`,
      displayName: 'Other Author Fixture',
      updatedAt: now,
    },
  ]);

  const fixturePosts: Array<{
    id: string;
    authorId: string;
    timestamp: Date;
    deletedAt: Date | null;
  }> = [];

  // Visible posts: published in the past and not deleted.
  for (let i = 0; i < VISIBLE_POSTS; i++) {
    fixturePosts.push({
      id: `post-${runId}-visible-${i}`,
      authorId: targetId,
      timestamp: new Date(now.getTime() - (i + 1) * hourMs),
      deletedAt: null,
    });
  }

  // Soft-deleted post: the profile list never shows it.
  fixturePosts.push({
    id: `post-${runId}-deleted`,
    authorId: targetId,
    timestamp: new Date(now.getTime() - 4 * hourMs),
    deletedAt: new Date(now.getTime() - hourMs),
  });

  // Future-scheduled post: not published yet, so the list hides it and
  // its existence must not be hinted at by the header count.
  fixturePosts.push({
    id: `post-${runId}-future`,
    authorId: targetId,
    timestamp: new Date(now.getTime() + 24 * hourMs),
    deletedAt: null,
  });

  // Control: another author's visible post must never be counted.
  fixturePosts.push({
    id: `post-${runId}-other`,
    authorId: otherId,
    timestamp: new Date(now.getTime() - hourMs),
    deletedAt: null,
  });

  for (const p of fixturePosts) {
    postIds.push(p.id);
  }
  await db.insert(posts).values(
    fixturePosts.map((p) => ({
      id: p.id,
      content: `fixture ${p.id}`,
      authorId: p.authorId,
      timestamp: p.timestamp,
      createdAt: p.timestamp,
      deletedAt: p.deletedAt,
    }))
  );
});

afterAll(async () => {
  await invalidateCache(targetId, { namespace: 'user:profile:stats' });
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, [targetId, otherId]));
});

describe('profile post count vs profile post list', () => {
  it('the profile list shows only the visible posts', async () => {
    const list = await getDbInstance().getPostsByActor(targetId, 100);
    expect(list).toHaveLength(EXPECTED_POSTS);
    for (const post of list) {
      expect(post.deletedAt).toBeNull();
      expect(post.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it('the profile header post count matches the visible list', async () => {
    const response = await getProfile(
      new NextRequest(`https://feed.example/api/users/${targetId}/profile`),
      { params: Promise.resolve({ userId: targetId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user: { stats: { posts: number } } | null };
      user?: { stats: { posts: number } } | null;
    };
    const user = body.data?.user ?? body.user;
    expect(user?.stats.posts).toBe(EXPECTED_POSTS);
  });
});
