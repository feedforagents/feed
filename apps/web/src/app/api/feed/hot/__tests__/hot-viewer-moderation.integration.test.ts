/**
 * GET /api/feed/hot against a real database: the shared hot snapshot must be
 * filtered per viewer by the viewer's block/mute policy before paging, the
 * same way the stories feed applies `filterStoriesForViewer` to its shared
 * snapshot. Authors the viewer blocked or muted — and authors who blocked
 * the viewer — must not appear in the viewer's hot feed, including through
 * reposts of their posts, and the page must be filled from the remaining
 * candidates instead of coming back short.
 *
 * Anonymous requests keep the unfiltered public snapshot.
 *
 * Fixture rows are namespaced by a per-run id and are not deleted.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { db, posts, reactions, userBlocks, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type HotResponse = {
  posts: Array<{ id: string; authorId: string }>;
};

const LIKES_HIGH = 12;
const LIKES_MID = 11;
const LIKES_LOW = 10;
const LIKES_VISIBLE = 1;

let viewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockerAuthorId: string;
let visibleAuthorId: string;
let currentViewerId: string | null = null;

const postIds = {
  blocked1: '',
  blocked2: '',
  muted: '',
  blocker: '',
  visible1: '',
  visible2: '',
  visible3: '',
  repostOfBlocked: '',
};

let GET: typeof import('../route').GET;

beforeAll(async () => {
  // Real-database fixture setup; exceeds the default 5s hook timeout.
  [viewerId, blockedAuthorId, mutedAuthorId, blockerAuthorId, visibleAuthorId] =
    await Promise.all(Array.from({ length: 5 }, () => generateSnowflakeId()));
  const likerIds = await Promise.all(
    Array.from({ length: LIKES_HIGH }, () => generateSnowflakeId())
  );
  for (const key of Object.keys(postIds) as Array<keyof typeof postIds>) {
    postIds[key] = await generateSnowflakeId();
  }

  const apiIndex = path.resolve(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages/api/src/index.ts'
  );
  const actualApi = await import(apiIndex);
  mock.module('@feed/api', () => ({
    ...actualApi,
    optionalAuth: async () =>
      currentViewerId ? { userId: currentViewerId } : null,
  }));
  ({ GET } = await import('../route'));

  const runId = await generateSnowflakeId();
  const now = new Date();
  const allUserIds = [
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockerAuthorId,
    visibleAuthorId,
    ...likerIds,
  ];
  await db.insert(users).values(
    allUserIds.map((id) => ({
      id,
      username: `test-hotmod-${runId}-${id}`,
      displayName: 'Hot moderation fixture',
      updatedAt: now,
    }))
  );

  await db.insert(userBlocks).values([
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: blockedAuthorId,
    },
    {
      id: await generateSnowflakeId(),
      blockerId: blockerAuthorId,
      blockedId: viewerId,
    },
  ]);
  await db.insert(userMutes).values({
    id: await generateSnowflakeId(),
    muterId: viewerId,
    mutedId: mutedAuthorId,
  });

  const postRows = [
    { key: 'blocked1' as const, authorId: blockedAuthorId, likes: LIKES_HIGH },
    { key: 'blocked2' as const, authorId: blockedAuthorId, likes: LIKES_HIGH },
    { key: 'muted' as const, authorId: mutedAuthorId, likes: LIKES_MID },
    { key: 'blocker' as const, authorId: blockerAuthorId, likes: LIKES_LOW },
    {
      key: 'visible1' as const,
      authorId: visibleAuthorId,
      likes: LIKES_VISIBLE,
    },
    {
      key: 'visible2' as const,
      authorId: visibleAuthorId,
      likes: LIKES_VISIBLE,
    },
    {
      key: 'visible3' as const,
      authorId: visibleAuthorId,
      likes: LIKES_VISIBLE,
    },
  ];
  await db.insert(posts).values(
    postRows.map((row) => ({
      id: postIds[row.key],
      authorId: row.authorId,
      content: `hot moderation fixture ${row.key}`,
      timestamp: now,
      createdAt: now,
    }))
  );
  // A repost by the visible author of the blocked author's post: the
  // original author is what the viewer must not see.
  await db.insert(posts).values({
    id: postIds.repostOfBlocked,
    authorId: visibleAuthorId,
    content: 'hot moderation fixture repost',
    type: 'repost',
    originalPostId: postIds.blocked1,
    timestamp: now,
    createdAt: now,
  });

  const reactionRows: Array<{
    id: string;
    postId: string;
    userId: string;
    type: string;
  }> = [];
  for (const row of postRows) {
    for (let i = 0; i < row.likes; i++) {
      reactionRows.push({
        id: await generateSnowflakeId(),
        postId: postIds[row.key],
        userId: likerIds[i],
        type: 'like',
      });
    }
  }
  for (let i = 0; i < LIKES_HIGH; i++) {
    reactionRows.push({
      id: await generateSnowflakeId(),
      postId: postIds.repostOfBlocked,
      userId: likerIds[i],
      type: 'like',
    });
  }
  await db.insert(reactions).values(reactionRows);
}, 120_000);

async function fetchHot(limit: number) {
  const response = await GET(
    new NextRequest(`https://feed.example/api/feed/hot?limit=${limit}`)
  );
  expect(response.status).toBe(200);
  return (await response.json()) as HotResponse;
}

describe('GET /api/feed/hot viewer moderation', () => {
  it('hides blocked, muted and blocking authors (and their reposts) from the viewer and fills the page with visible posts', async () => {
    currentViewerId = viewerId;
    const { posts: page } = await fetchHot(3);
    expect(page.map((p) => p.id).sort()).toEqual(
      [postIds.visible1, postIds.visible2, postIds.visible3].sort()
    );
    expect(
      page.some((p) =>
        [blockedAuthorId, mutedAuthorId, blockerAuthorId].includes(p.authorId)
      )
    ).toBe(false);
  });

  it('keeps the unfiltered snapshot for anonymous requests', async () => {
    currentViewerId = null;
    const { posts: page } = await fetchHot(3);
    expect(page).toHaveLength(3);
    expect(page.some((p) => p.authorId === blockedAuthorId)).toBe(true);
  });
});
