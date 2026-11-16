/**
 * GET /api/users/[userId]/posts?type=posts must apply the viewer's
 * moderation policy to the original post embedded in a repost/quote.
 *
 * The codebase has one viewer rule, stated in loadViewerExcludedAuthorIds
 * ("Authors the viewer must not see: users they blocked or muted, and
 * users who blocked them") and applied before paging in the web feed
 * (feed/hot excludes the author AND the original author of a repost),
 * stories, comments, post detail and favorites feed, and in MCP
 * search_users (#1885), query_feed (#1863), get_favorite_posts (F11-01)
 * and get_group_invites (F9-01). The same route's replies branch already
 * applies it to embedded parents (open #1829, dd12m54: "A parent post by
 * an author the viewer must not see is never exposed either; the reply
 * renders with post: null instead, like for a deleted or future
 * parent").
 *
 * The posts branch of the same route skips the rule entirely: a simple
 * repost or quote whose original author the viewer blocked, muted, or
 * was blocked by still embeds the original post's full content, author
 * name and avatar. For a simple repost the row's entire visible content
 * IS the blocked author's post (the repost itself has empty content).
 * The route already drops a simple repost whose original is deleted and
 * renders a quote of a deleted original with originalPost: null — the
 * same treatment fits a non-exposable original.
 *
 * Real DB, real route handler, no mocks.
 *
 * Run with: DISABLE_RATE_LIMITING=true STEWARD_JWT_SECRET=<any non-empty value>
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f15r2
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f15r2
 *   TZ=UTC bun test integration/profile-posts-repost-original-viewer-moderation.integration.test.ts
 *   --preload ./integration/preload.ts
 * (STEWARD_JWT_SECRET must be set: the route authenticates via
 * publicRateLimit/optionalAuth, which only accepts a real steward JWT —
 * the helper signs one with the same secret the verifier reads.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  closeDatabase,
  db,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

let POSTS_GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

// The route authenticates via publicRateLimit/optionalAuth, which only
// accepts a real steward JWT (the `steward:test:` DID shortcut lives in
// authenticate(), not optionalAuth). Sign a short-lived JWT with the same
// STEWARD_JWT_SECRET the verifier reads, and link the fixture users via
// stewardId so the payload resolves to the right viewer.
const webBearer = async (userId: string) =>
  `Bearer ${await createStewardTestToken(userId)}`;

const OWNER = 'f15-owner';
const VIEWER = 'f15-viewer';
const NORMAL = 'f15-normal';
const BLOCKED = 'f15-blocked';
const MUTED = 'f15-muted';
const BLOCKER = 'f15-blocker';

const postIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];

// Row ids, so tests can find their row by id instead of by position.
let OWN_POST = '';
let REPOST_NORMAL = '';
let REPOST_BLOCKED = '';
let REPOST_BLOCKER = '';
let QUOTE_MUTED = '';
let QUOTE_BLOCKER = '';
let QUOTE_NORMAL = '';

type PostItem = {
  id: string;
  content: string;
  authorId: string;
  isRepost?: boolean;
  isQuote?: boolean;
  originalPostId?: string | null;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    authorName?: string | null;
  } | null;
};
type PostsResponse = { type: string; total: number; items: PostItem[] };

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

async function insertBlock(blockerId: string, blockedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
    createdAt: new Date(),
  });
  blockIds.push(id);
}

async function insertMute(muterId: string, mutedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userMutes).values({
    id,
    muterId,
    mutedId,
    createdAt: new Date(),
  });
  muteIds.push(id);
}

async function callPosts(
  viewerId: string | null
): Promise<{ status: number; items: PostItem[]; total: number }> {
  const headers: Record<string, string> = {};
  if (viewerId) headers.authorization = await webBearer(viewerId);
  const request = new NextRequest(
    new Request(
      `http://localhost/api/users/${OWNER}/posts?type=posts&page=1&limit=100`,
      { method: 'GET', headers }
    )
  );
  const response = await POSTS_GET(request, {
    params: Promise.resolve({ userId: OWNER }),
  });
  const payload = (await response.json().catch(() => null)) as
    | ({
        data?: PostsResponse;
      } & PostsResponse)
    | null;
  const data = payload?.data ?? payload;
  return {
    status: response.status,
    items: (data as PostsResponse)?.items ?? [],
    total: (data as PostsResponse)?.total ?? -1,
  };
}

describe('profile posts repost original viewer moderation', () => {
  beforeAll(async () => {
    ({ GET: POSTS_GET } = await import(
      '../../../apps/web/src/app/api/users/[userId]/posts/route'
    ));
    for (const id of [OWNER, VIEWER, NORMAL, BLOCKED, MUTED, BLOCKER]) {
      await insertUser(id);
    }

    const now = new Date();
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
    const earlier = new Date(now.getTime() - 3_600_000);

    // Original posts, one per author class.
    const [postNormal, postBlocked, postMuted, postBlocker] = await Promise.all(
      Array.from({ length: 4 }, () => generateSnowflakeId())
    );
    await insertPost(
      postNormal,
      NORMAL,
      'f15 original by normal',
      null,
      earlier
    );
    await insertPost(
      postBlocked,
      BLOCKED,
      'f15 original by blocked',
      null,
      earlier
    );
    await insertPost(postMuted, MUTED, 'f15 original by muted', null, earlier);
    await insertPost(
      postBlocker,
      BLOCKER,
      'f15 original by blocker',
      null,
      earlier
    );

    // Owner rows, newest first so ids are unambiguous.
    [
      OWN_POST,
      REPOST_NORMAL,
      REPOST_BLOCKED,
      REPOST_BLOCKER,
      QUOTE_MUTED,
      QUOTE_BLOCKER,
      QUOTE_NORMAL,
    ] = await Promise.all(
      Array.from({ length: 7 }, () => generateSnowflakeId())
    );
    await insertPost(OWN_POST, OWNER, 'f15 own post', null, at(-100));
    await insertPost(REPOST_NORMAL, OWNER, '', postNormal, at(-90));
    await insertPost(REPOST_BLOCKED, OWNER, '', postBlocked, at(-80));
    await insertPost(REPOST_BLOCKER, OWNER, '', postBlocker, at(-70));
    await insertPost(
      QUOTE_MUTED,
      OWNER,
      'f15 quote of muted',
      postMuted,
      at(-60)
    );
    await insertPost(
      QUOTE_BLOCKER,
      OWNER,
      'f15 quote of blocker',
      postBlocker,
      at(-50)
    );
    await insertPost(
      QUOTE_NORMAL,
      OWNER,
      'f15 quote of normal',
      postNormal,
      at(-40)
    );

    // Viewer blocked BLOCKED, muted MUTED, is blocked by BLOCKER.
    await insertBlock(VIEWER, BLOCKED);
    await insertMute(VIEWER, MUTED);
    await insertBlock(BLOCKER, VIEWER);
  });

  afterAll(async () => {
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(userMutes).where(inArray(userMutes.id, muteIds));
    await db
      .delete(users)
      .where(
        inArray(users.id, [OWNER, VIEWER, NORMAL, BLOCKED, MUTED, BLOCKER])
      );
    await closeDatabase();
  });

  it('viewer: simple reposts of blocked and blocking authors are not listed', async () => {
    const { status, items, total } = await callPosts(VIEWER);
    expect(status).toEqual(200);
    const ids = items.map((row) => row.id);
    expect(ids).not.toContain(REPOST_BLOCKED);
    expect(ids).not.toContain(REPOST_BLOCKER);
    expect(ids).toContain(OWN_POST);
    expect(ids).toContain(REPOST_NORMAL);
    expect(total).toEqual(items.length);
  });

  it('viewer: quotes of muted and blocking authors keep the row but hide the original', async () => {
    const { items } = await callPosts(VIEWER);
    const muted = items.find((row) => row.id === QUOTE_MUTED);
    const blocker = items.find((row) => row.id === QUOTE_BLOCKER);
    expect(muted).toBeDefined();
    expect(blocker).toBeDefined();
    expect(muted!.originalPost).toBeNull();
    expect(blocker!.originalPost).toBeNull();
    expect(muted!.content).toEqual('f15 quote of muted');
    expect(blocker!.content).toEqual('f15 quote of blocker');
  });

  it('viewer: normal repost and quote keep their originals', async () => {
    const { items } = await callPosts(VIEWER);
    const repost = items.find((row) => row.id === REPOST_NORMAL);
    const quote = items.find((row) => row.id === QUOTE_NORMAL);
    expect(repost?.originalPost?.content).toEqual('f15 original by normal');
    expect(quote?.originalPost?.content).toEqual('f15 original by normal');
  });

  it('anonymous: all rows listed with originals exposed', async () => {
    const { status, items, total } = await callPosts(null);
    expect(status).toEqual(200);
    expect(items.length).toEqual(7);
    expect(total).toEqual(7);
    const blocked = items.find((row) => row.id === REPOST_BLOCKED);
    expect(blocked?.originalPost?.content).toEqual('f15 original by blocked');
    const muted = items.find((row) => row.id === QUOTE_MUTED);
    expect(muted?.originalPost?.content).toEqual('f15 original by muted');
  });

  it('unrelated viewer: all rows listed with originals exposed', async () => {
    const { status, items, total } = await callPosts(NORMAL);
    expect(status).toEqual(200);
    expect(items.length).toEqual(7);
    expect(total).toEqual(7);
    const blocked = items.find((row) => row.id === REPOST_BLOCKED);
    expect(blocked?.originalPost?.content).toEqual('f15 original by blocked');
    const blocker = items.find((row) => row.id === QUOTE_BLOCKER);
    expect(blocker?.originalPost?.content).toEqual('f15 original by blocker');
  });
});
