/**
 * MCP get_post against a real database: the commentCount it returns must
 * count only the comments the viewer can actually see, matching the web
 * comment list (GET /api/posts/[id]/comments), whose total counts just
 * the moderation-filtered rows it returns.
 *
 * PRD §8.1 requires MCP tools to use the same business logic as the
 * website, moderation explicitly included. The web comment list excludes
 * comments by authors the viewer blocked or muted — or who blocked the
 * viewer. executeGetPost proxies the public post detail route without
 * any viewer identity, so the count it hands back includes those hidden
 * comments: the agent reports a number the user can never reconcile
 * with the comments they are shown.
 *
 * The proxied detail route is the real route handler, served over real
 * HTTP on an ephemeral port exactly as production serves it, and the
 * MCP handler is the real executeGetPost. Only the server-only
 * environment marker is stubbed; no business logic is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  eq,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { executeGetPost } from '../../mcp/src/handlers/tool-handlers';

let detailGET: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let commentsGET: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

let viewerId: string;
let bystanderId: string;
let authorId: string;
let postId: string;
let viewerToken: string;
let server: ReturnType<typeof Bun.serve>;
let savedAppUrl: string | undefined;

const allUserIds: string[] = [];
const allCommentIds: string[] = [];
const allBlockIds: string[] = [];
const allMuteIds: string[] = [];

type PostDetailResponse = {
  success: boolean;
  data: { commentCount: number };
};

type CommentsResponse = {
  success: boolean;
  data: { total: number };
};

async function signViewerToken(stewardId: string): Promise<string> {
  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  return new SignJWT({ userId: stewardId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

beforeAll(async () => {
  detailGET = (await import('../../../apps/web/src/app/api/posts/[id]/route'))
    .GET;
  commentsGET = (
    await import('../../../apps/web/src/app/api/posts/[id]/comments/route')
  ).GET;

  // Serve the real post detail route over HTTP so the real executeGetPost
  // proxy fetches it exactly as it does in production.
  savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
      if (!match) return new Response('not found', { status: 404 });
      const request = new NextRequest(req);
      return detailGET(request, {
        params: Promise.resolve({ id: match[1] as string }),
      });
    },
  });
  process.env.NEXT_PUBLIC_APP_URL = `http://127.0.0.1:${server.port}`;

  const ids = await Promise.all(
    Array.from({ length: 24 }, () => generateSnowflakeId())
  );
  let i = 0;
  const nextId = () => ids[i++] as string;
  viewerId = nextId();
  bystanderId = nextId();
  authorId = nextId();
  const normalId = nextId();
  const blockedId = nextId();
  const mutedId = nextId();
  const blockerId = nextId();
  postId = nextId();
  allUserIds.push(
    viewerId,
    bystanderId,
    authorId,
    normalId,
    blockedId,
    mutedId,
    blockerId
  );

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  const mkUser = (id: string, label: string, stewardId?: string) => ({
    id,
    username: `f180-${label}-${id}`,
    displayName: `F180 ${label}`,
    ...(stewardId ? { stewardId } : {}),
    updatedAt: now,
  });
  await db
    .insert(users)
    .values([
      mkUser(viewerId, 'viewer', `f180-${viewerId}`),
      mkUser(bystanderId, 'bystander'),
      mkUser(authorId, 'author'),
      mkUser(normalId, 'normal'),
      mkUser(blockedId, 'blocked'),
      mkUser(mutedId, 'muted'),
      mkUser(blockerId, 'blocker'),
    ]);

  // Viewer blocks `blocked` and mutes `muted`; `blocker` blocks the viewer.
  const blockA = nextId();
  const blockB = nextId();
  const mute = nextId();
  allBlockIds.push(blockA, blockB);
  allMuteIds.push(mute);
  await db.insert(userBlocks).values([
    { id: blockA, blockerId: viewerId, blockedId: blockedId },
    { id: blockB, blockerId: blockerId, blockedId: viewerId },
  ]);
  await db.insert(userMutes).values({
    id: mute,
    muterId: viewerId,
    mutedId: mutedId,
  });

  await db.insert(posts).values({
    id: postId,
    content: 'fixture post for MCP get_post comment counts',
    authorId,
    timestamp: earlier,
    createdAt: earlier,
  });

  // Five live top-level comments: two visible to the viewer (normal
  // author), three hidden from the viewer (blocked, muted, blocker
  // authors). One more comment is soft-deleted and must never be counted
  // by anyone. A live reply by the normal author hangs under the blocked
  // author's comment: the comment list omits it with its hidden parent,
  // so it is visible to the bystander only.
  const mkComment = (
    author: string,
    label: string,
    deletedAt: Date | null,
    parentCommentId: string | null = null
  ) => {
    const id = nextId();
    allCommentIds.push(id);
    return {
      id,
      content: `f180 comment ${label}`,
      postId,
      authorId: author,
      parentCommentId,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt,
    };
  };
  const blockedComment = mkComment(blockedId, 'blocked author', null);
  await db
    .insert(comments)
    .values([
      mkComment(normalId, 'visible a', null),
      mkComment(normalId, 'visible b', null),
      blockedComment,
      mkComment(mutedId, 'muted author', null),
      mkComment(blockerId, 'blocker author', null),
      mkComment(normalId, 'soft deleted', now),
      mkComment(
        normalId,
        'reply under blocked parent',
        null,
        blockedComment.id
      ),
    ]);

  viewerToken = await signViewerToken(`f180-${viewerId}`);
});

afterAll(async () => {
  server.stop(true);
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(userBlocks).where(inArray(userBlocks.id, allBlockIds));
  await db.delete(userMutes).where(inArray(userMutes.id, allMuteIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('MCP get_post commentCount viewer moderation', () => {
  it('web comment list total for the viewer counts only visible comments', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/posts/${postId}/comments`, {
        headers: { authorization: `Bearer ${viewerToken}` },
      })
    );
    const response = await commentsGET(request, {
      params: Promise.resolve({ id: postId }),
    });
    const body = (await response.json()) as CommentsResponse;
    expect(body.data.total).toBe(2);
  });

  it('MCP get_post commentCount counts only comments visible to the viewer', async () => {
    const result = (await executeGetPost(
      { agentId: 'f180-agent', userId: viewerId },
      { postId }
    )) as unknown as PostDetailResponse;
    expect(result.data.commentCount).toBe(2);
  });

  it('MCP get_post commentCount for a viewer with no moderation relations is the full live count', async () => {
    const result = (await executeGetPost(
      { agentId: 'f180-agent', userId: bystanderId },
      { postId }
    )) as unknown as PostDetailResponse;
    expect(result.data.commentCount).toBe(6);
  });
});
