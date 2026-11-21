/**
 * GET /api/posts/[id] must not expose a repost's original post when the
 * original's author is in the viewer's moderation exclusion set (blocked,
 * muted, or blocked the viewer). A simple repost's visible content *is* the
 * original, so returning the original in full is full exposure.
 *
 * The route already loads `loadViewerExcludedAuthorIds` for the comment tree
 * (the same definition the feed lists, profile list (#1940), MCP get_post
 * (#1960) and trending widget (#1934) use), but the repost metadata block
 * never consulted it — the excluded author's original post came back in full
 * for a signed-in viewer. Anonymous reads have no moderation set and stay
 * unfiltered.
 *
 * Treatment at the head mirrors the route's own deleted-original behaviour:
 * an original that must not be exposed produces no repost metadata at all
 * (no isRepost/isQuote/quoteComment/originalPostId/originalPost keys); the
 * quote's own commentary survives in `content`.
 *
 * Real DB, real route handler, no mocks.
 *
 * Run with: DISABLE_RATE_LIMITING=true STEWARD_JWT_SECRET=<any non-empty value>
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_postdetail
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_postdetail
 *   TZ=UTC bun test ./post-detail-repost-original-moderation.integration.test.ts
 *   --preload ./preload.ts
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { closeDatabase, db, inArray, posts, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

let POST_GET: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;

const webBearer = async (userId: string) =>
  `Bearer ${await createStewardTestToken(userId)}`;

const OWNER = 'pdmod-owner';
const VIEWER = 'pdmod-viewer';
const NORMAL = 'pdmod-normal';
const BLOCKED = 'pdmod-blocked';

const postIds: string[] = [];
const blockIds: string[] = [];

let OB = ''; // original by BLOCKED
let ON = ''; // original by NORMAL
let SRB = ''; // owner simple repost of OB
let QB = ''; // owner quote of OB
let SRN = ''; // owner simple repost of ON

type PostDetail = {
  id?: string;
  content?: string | null;
  isRepost?: boolean;
  isQuote?: boolean;
  quoteComment?: string | null;
  originalPostId?: string;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
  } | null;
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

async function fetchPost(
  postId: string,
  viewerId: string | null
): Promise<{ status: number; body: PostDetail }> {
  const headers: Record<string, string> = {};
  if (viewerId) headers.authorization = await webBearer(viewerId);
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}`, {
      method: 'GET',
      headers,
    })
  );
  const response = await POST_GET(request, {
    params: Promise.resolve({ id: postId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | ({ data?: PostDetail } & PostDetail)
    | null;
  return {
    status: response.status,
    body: payload?.data ?? payload ?? {},
  };
}

describe('post detail repost original moderation', () => {
  beforeAll(async () => {
    mock.module('server-only', () => ({}));
    ({ GET: POST_GET } = await import(
      '../../../apps/web/src/app/api/posts/[id]/route'
    ));
    for (const id of [OWNER, VIEWER, NORMAL, BLOCKED]) {
      await insertUser(id);
    }

    const now = new Date();
    const earlier = new Date(now.getTime() - 3_600_000);

    [OB, ON, SRB, QB, SRN] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    await insertPost(OB, BLOCKED, 'pdmod original by blocked', null, earlier);
    await insertPost(ON, NORMAL, 'pdmod original by normal', null, earlier);
    await insertPost(SRB, OWNER, '', OB, now);
    await insertPost(QB, OWNER, 'pdmod quote of blocked', OB, now);
    await insertPost(SRN, OWNER, '', ON, now);

    // Viewer blocked BLOCKED.
    const blockId = await generateSnowflakeId();
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: VIEWER,
      blockedId: BLOCKED,
      createdAt: now,
    });
    blockIds.push(blockId);
  });

  afterAll(async () => {
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db
      .delete(users)
      .where(inArray(users.id, [OWNER, VIEWER, NORMAL, BLOCKED]));
    await closeDatabase();
  }, 10_000);

  it('viewer: a simple repost of a blocked original exposes no original', async () => {
    const { status, body } = await fetchPost(SRB, VIEWER);
    expect(status).toBe(200);
    expect(body.originalPost).toBeUndefined();
    expect(body.isRepost).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('pdmod original by blocked');
  });

  it('viewer: a quote of a blocked original keeps its commentary but exposes no original', async () => {
    const { status, body } = await fetchPost(QB, VIEWER);
    expect(status).toBe(200);
    expect(body.content).toBe('pdmod quote of blocked');
    expect(body.originalPost).toBeUndefined();
    expect(body.isRepost).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('pdmod original by blocked');
  });

  it('viewer: a repost of a normal original still embeds the original', async () => {
    const { status, body } = await fetchPost(SRN, VIEWER);
    expect(status).toBe(200);
    expect(body.isRepost).toBe(true);
    expect(body.originalPost?.content).toBe('pdmod original by normal');
    expect(body.originalPost?.authorId).toBe(NORMAL);
  });

  it('anonymous: the same simple repost stays unfiltered', async () => {
    const { status, body } = await fetchPost(SRB, null);
    expect(status).toBe(200);
    expect(body.isRepost).toBe(true);
    expect(body.originalPost?.content).toBe('pdmod original by blocked');
  });
});
