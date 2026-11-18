/**
 * GET /api/posts must not expose a simple repost's original post when the
 * original's author is in the viewer's moderation exclusion set (blocked,
 * muted, or blocked the viewer). A simple repost's visible content *is* the
 * original, so returning the original in full is full exposure.
 *
 * The SQL visibility conditions (`postFeedVisibilityConditions`) excluded
 * only posts *authored by* excluded authors; a simple repost whose ORIGINAL
 * author is excluded passed the SQL filter, consumed a page slot, and was
 * embedded in full by both feed paths. The profile post list (#1940), the
 * single-post route (#1962), the MCP get_post tool (#1960) and the trending
 * widget (#1934) already apply the exclusion set to embedded originals.
 *
 * Fix: the SQL conditions now exclude simple reposts of excluded-author
 * originals before the page is cut (so hidden rows never consume page
 * slots — the same reason the dead-repost subplan exists), and both render
 * paths omit the embedded original: the recent path drops the simple
 * repost row and renders a quote with `originalPost: null`; the following
 * path (which renders dead originals as blank rows) omits the repost
 * metadata entirely. Anonymous reads have no moderation set and stay
 * unfiltered.
 *
 * Real DB, real route handler, no mocks.
 *
 * Run with: DISABLE_RATE_LIMITING=true STEWARD_JWT_SECRET=<any non-empty value>
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_feedmod
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_feedmod
 *   TZ=UTC bun test ./feed-repost-original-moderation.integration.test.ts
 *   --preload ./preload.ts
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  closeDatabase,
  db,
  eq,
  follows,
  inArray,
  posts,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

let POSTS_GET: typeof import('../../../apps/web/src/app/api/posts/route').GET;

const webBearer = async (userId: string) =>
  `Bearer ${await createStewardTestToken(userId)}`;

const OWNER = 'fdmod-owner';
const VIEWER = 'fdmod-viewer';
const NORMAL = 'fdmod-normal';
const BLOCKED = 'fdmod-blocked';

const postIds: string[] = [];
const blockIds: string[] = [];

let OB = ''; // original by BLOCKED
let ON = ''; // original by NORMAL
let V1 = ''; // owner own post 1
let H1 = ''; // owner simple repost of OB
let V2 = ''; // owner own post 2
let Q1 = ''; // owner quote of OB
let R1 = ''; // owner simple repost of ON

type FeedPost = {
  id?: string;
  content?: string | null;
  isRepost?: boolean;
  isQuote?: boolean;
  originalPostId?: string;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
  } | null;
};

type FeedResponse = {
  success?: boolean;
  posts?: FeedPost[];
  limit?: number;
  cursor?: string | null;
  hasMore?: boolean;
  source?: string;
};

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    stewardId: id,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertPost(
  id: string,
  authorId: string,
  content: string,
  originalPostId: string | null,
  at: Date
) {
  await db.insert(posts).values({
    id,
    content,
    authorId,
    originalPostId,
    timestamp: at,
    createdAt: at,
  });
  postIds.push(id);
}

async function getFeed(
  viewerId: string | null,
  limit: number,
  cursor?: string
): Promise<FeedResponse> {
  const headers: Record<string, string> = {};
  if (viewerId) headers.authorization = await webBearer(viewerId);
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?${params}`, {
      method: 'GET',
      headers,
    })
  );
  const response = await POSTS_GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as FeedResponse;
}

async function getFollowing(
  viewerId: string,
  limit: number
): Promise<FeedResponse> {
  const headers: Record<string, string> = {};
  headers.authorization = await webBearer(viewerId);
  const request = new NextRequest(
    new Request(
      `http://localhost/api/posts?following=true&userId=${viewerId}&limit=${limit}`,
      { method: 'GET', headers }
    )
  );
  const response = await POSTS_GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as FeedResponse;
}

describe('feed repost original moderation', () => {
  beforeAll(async () => {
    mock.module('server-only', () => ({}));
    ({ GET: POSTS_GET } = await import(
      '../../../apps/web/src/app/api/posts/route'
    ));
    for (const id of [OWNER, VIEWER, NORMAL, BLOCKED]) {
      await insertUser(id);
    }

    const now = new Date();
    const earlier = new Date(now.getTime() - 3_600_000);

    [OB, ON, V1, H1, V2, Q1, R1] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    await insertPost(OB, BLOCKED, 'fdmod original by blocked', null, earlier);
    await insertPost(ON, NORMAL, 'fdmod original by normal', null, earlier);
    await insertPost(V1, OWNER, 'fdmod own post 1', null, now);
    await insertPost(H1, OWNER, '', OB, new Date(now.getTime() - 1000));
    await insertPost(
      V2,
      OWNER,
      'fdmod own post 2',
      null,
      new Date(now.getTime() - 2000)
    );
    await insertPost(
      Q1,
      OWNER,
      'fdmod quote of blocked',
      OB,
      new Date(now.getTime() - 3000)
    );
    await insertPost(R1, OWNER, '', ON, new Date(now.getTime() - 4000));

    // Viewer blocked BLOCKED, and follows OWNER for the following feed.
    const blockId = await generateSnowflakeId();
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: VIEWER,
      blockedId: BLOCKED,
      createdAt: now,
    });
    blockIds.push(blockId);
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: VIEWER,
      followingId: OWNER,
      createdAt: now,
    });
  });

  afterAll(async () => {
    await db.delete(follows).where(eq(follows.followerId, VIEWER));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db
      .delete(users)
      .where(inArray(users.id, [OWNER, VIEWER, NORMAL, BLOCKED]));
    await closeDatabase();
  }, 10_000);

  it('viewer: hidden reposts do not consume page slots', async () => {
    const page1 = await getFeed(VIEWER, 2);
    expect(page1.posts?.map((p) => p.id)).toEqual([V1, V2]);
    expect(page1.hasMore).toBe(true);
  });

  it('viewer: paging through limit=1 visits every visible row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const result = await getFeed(VIEWER, 1, cursor);
      for (const post of result.posts ?? []) {
        expect(seen).not.toContain(post.id);
        seen.push(post.id as string);
      }
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }
    // The recent feed is global: the normal author's original (ON) is a
    // visible row too; the blocked author's original (OB) is not.
    expect(seen).toEqual([V1, V2, Q1, R1, ON]);
  });

  it('viewer: a quote of a blocked original keeps its row with a null original', async () => {
    const page = await getFeed(VIEWER, 3);
    const quote = page.posts?.find((p) => p.id === Q1);
    expect(quote).toBeDefined();
    expect(quote?.content).toBe('fdmod quote of blocked');
    expect(quote?.originalPost).toBeNull();
    expect(JSON.stringify(page)).not.toContain('fdmod original by blocked');
  });

  it('viewer: a repost of a normal original still embeds the original', async () => {
    const page = await getFeed(VIEWER, 10);
    const repost = page.posts?.find((p) => p.id === R1);
    expect(repost?.isRepost).toBe(true);
    expect(repost?.originalPost?.content).toBe('fdmod original by normal');
    expect(repost?.originalPost?.authorId).toBe(NORMAL);
  });

  it('anonymous: the same page stays unfiltered', async () => {
    const page = await getFeed(null, 5);
    const hidden = page.posts?.find((p) => p.id === H1);
    expect(hidden?.isRepost).toBe(true);
    expect(hidden?.originalPost?.content).toBe('fdmod original by blocked');
    expect(page.posts?.map((p) => p.id)).toEqual([V1, H1, V2, Q1, R1]);
  });

  it('viewer following feed: no blocked original is exposed', async () => {
    const page = await getFollowing(VIEWER, 10);
    expect(page.source).toBe('following');
    const body = JSON.stringify(page);
    expect(body).not.toContain('fdmod original by blocked');
    // The quote keeps its own commentary; the simple repost of a blocked
    // original renders without repost metadata; the normal original is
    // still embedded.
    const quote = page.posts?.find((p) => p.id === Q1);
    expect(quote?.content).toBe('fdmod quote of blocked');
    expect(quote?.originalPost).toBeUndefined();
    const hidden = page.posts?.find((p) => p.id === H1);
    expect(hidden?.originalPost).toBeUndefined();
    const repost = page.posts?.find((p) => p.id === R1);
    expect(repost?.originalPost?.content).toBe('fdmod original by normal');
  });
});
