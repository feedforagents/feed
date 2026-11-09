/**
 * GET /api/users/[userId]/posts?type=replies against a real database: the
 * public profile replies list must apply the viewer's own moderation policy
 * to the content it embeds and the counts it reports.
 *
 * Every sibling read surface already does this — the post feeds, the
 * favorites feed, notifications, user search and the post comment list all
 * exclude authors the viewer blocked or muted, and authors who blocked the
 * viewer (see apps/web/src/app/api/feed/_lib/viewer-moderation.ts: "Authors
 * the viewer must not see"). Within this same route, a parent post that
 * cannot be exposed (deleted or future-dated) already renders as
 * post: null while the reply itself stays listed (the #1688 contract), and
 * a deleted parent comment renders as parentComment: null. A parent post or
 * parent comment whose author the viewer must not see is the same kind of
 * non-exposable parent, and child replies by such authors must not be
 * counted (the rule the comment detail route applies to its reply counts).
 * The profile owner's own replies are the target of the page and stay
 * listed; anonymous reads have no moderation set and stay unfiltered.
 * The route handler is exercised unmodified; the viewer is a real Steward
 * JWT principal (publicRateLimit/optionalAuth accept nothing else).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { comments, db, inArray, posts, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ReplyItem = {
  id: string;
  content: string;
  replyCount: number;
  post: { id: string; content: string; authorId: string } | null;
  parentComment: { id: string; content: string; authorId: string } | null;
};
type RepliesResponse = {
  type: string;
  total: number;
  items: ReplyItem[];
};

const STEWARD_SECRET = 'f148-steward-secret';
process.env.STEWARD_JWT_SECRET =
  process.env.STEWARD_JWT_SECRET || STEWARD_SECRET;

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: 'f148-steward-viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.STEWARD_JWT_SECRET!));
  return { authorization: `Bearer ${token}` };
}

let owner: string;
let viewer: string;
let normal: string;
let blocked: string;
let muted: string;
let blocker: string;
let postNormal: string;
let postBlocked: string;
let postMuted: string;
let postBlocker: string;
let pcNormal: string;
let pcBlocked: string;
let pcMuted: string;
let pcBlocker: string;
let rPostNormal: string;
let rPostBlocked: string;
let rPostMuted: string;
let rPostBlocker: string;
let rPcNormal: string;
let rPcBlocked: string;
let rPcMuted: string;
let rPcBlocker: string;
const allUserIds: string[] = [];
const allPostIds: string[] = [];
const allCommentIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

async function fetchReplies(headers?: Record<string, string>) {
  const request = new NextRequest(
    `http://localhost/api/users/${owner}/posts?type=replies&limit=100`,
    { headers }
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId: owner }),
  });
  const body = (await response.json().catch(() => null)) as
    | RepliesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

function item(body: RepliesResponse | { error?: unknown } | null, id: string) {
  const found = (body as RepliesResponse)?.items?.find((row) => row.id === id);
  if (!found) throw new Error(`reply ${id} missing from response`);
  return found;
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  ));

  [
    owner,
    viewer,
    normal,
    blocked,
    muted,
    blocker,
    postNormal,
    postBlocked,
    postMuted,
    postBlocker,
    pcNormal,
    pcBlocked,
    pcMuted,
    pcBlocker,
    rPostNormal,
    rPostBlocked,
    rPostMuted,
    rPostBlocker,
    rPcNormal,
    rPcBlocked,
    rPcMuted,
    rPcBlocker,
  ] = await Promise.all(
    Array.from({ length: 22 }, () => generateSnowflakeId())
  );
  allUserIds.push(owner, viewer, normal, blocked, muted, blocker);
  allPostIds.push(postNormal, postBlocked, postMuted, postBlocker);

  const now = new Date();
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const earlier = new Date(now.getTime() - 3_600_000);

  await db.insert(users).values([
    {
      id: owner,
      username: `f148-o-${owner}`,
      displayName: 'F148 Owner',
      updatedAt: now,
    },
    {
      id: viewer,
      username: `f148-v-${viewer}`,
      displayName: 'F148 Viewer',
      updatedAt: now,
    },
    {
      id: normal,
      username: `f148-n-${normal}`,
      displayName: 'F148 Normal',
      updatedAt: now,
    },
    {
      id: blocked,
      username: `f148-b-${blocked}`,
      displayName: 'F148 Blocked',
      updatedAt: now,
    },
    {
      id: muted,
      username: `f148-m-${muted}`,
      displayName: 'F148 Muted',
      updatedAt: now,
    },
    {
      id: blocker,
      username: `f148-r-${blocker}`,
      displayName: 'F148 Blocker',
      updatedAt: now,
    },
  ]);
  await db
    .update(users)
    .set({ stewardId: 'f148-steward-viewer' })
    .where(sql`${users.id} = ${viewer}`);

  await db.insert(posts).values([
    {
      id: postNormal,
      content: 'f148 post by normal author',
      authorId: normal,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postBlocked,
      content: 'f148 post by blocked author',
      authorId: blocked,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postMuted,
      content: 'f148 post by muted author',
      authorId: muted,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postBlocker,
      content: 'f148 post by blocking author',
      authorId: blocker,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  // Parent comments on the normal post, one per author class.
  await db.insert(comments).values([
    {
      id: pcNormal,
      content: 'f148 parent comment by normal author',
      postId: postNormal,
      authorId: normal,
      parentCommentId: null,
      createdAt: at(-500),
      updatedAt: at(-500),
      deletedAt: null,
    },
    {
      id: pcBlocked,
      content: 'f148 parent comment by blocked author',
      postId: postNormal,
      authorId: blocked,
      parentCommentId: null,
      createdAt: at(-490),
      updatedAt: at(-490),
      deletedAt: null,
    },
    {
      id: pcMuted,
      content: 'f148 parent comment by muted author',
      postId: postNormal,
      authorId: muted,
      parentCommentId: null,
      createdAt: at(-480),
      updatedAt: at(-480),
      deletedAt: null,
    },
    {
      id: pcBlocker,
      content: 'f148 parent comment by blocking author',
      postId: postNormal,
      authorId: blocker,
      parentCommentId: null,
      createdAt: at(-470),
      updatedAt: at(-470),
      deletedAt: null,
    },
  ]);
  allCommentIds.push(pcNormal, pcBlocked, pcMuted, pcBlocker);

  // The profile owner's replies: one per parent-post author class, one per
  // parent-comment author class, plus one soft-deleted reply (control).
  const replyRows = [
    {
      id: rPostNormal,
      content: 'f148 reply on normal post',
      postId: postNormal,
      parentCommentId: null as string | null,
      createdAt: at(-100),
      deletedAt: null as Date | null,
    },
    {
      id: rPostBlocked,
      content: 'f148 reply on blocked-author post',
      postId: postBlocked,
      parentCommentId: null,
      createdAt: at(-110),
      deletedAt: null,
    },
    {
      id: rPostMuted,
      content: 'f148 reply on muted-author post',
      postId: postMuted,
      parentCommentId: null,
      createdAt: at(-120),
      deletedAt: null,
    },
    {
      id: rPostBlocker,
      content: 'f148 reply on blocking-author post',
      postId: postBlocker,
      parentCommentId: null,
      createdAt: at(-130),
      deletedAt: null,
    },
    {
      id: rPcNormal,
      content: 'f148 reply under normal parent comment',
      postId: postNormal,
      parentCommentId: pcNormal,
      createdAt: at(-140),
      deletedAt: null,
    },
    {
      id: rPcBlocked,
      content: 'f148 reply under blocked parent comment',
      postId: postNormal,
      parentCommentId: pcBlocked,
      createdAt: at(-150),
      deletedAt: null,
    },
    {
      id: rPcMuted,
      content: 'f148 reply under muted parent comment',
      postId: postNormal,
      parentCommentId: pcMuted,
      createdAt: at(-160),
      deletedAt: null,
    },
    {
      id: rPcBlocker,
      content: 'f148 reply under blocking parent comment',
      postId: postNormal,
      parentCommentId: pcBlocker,
      createdAt: at(-170),
      deletedAt: null,
    },
  ];
  const deletedReplyId = await generateSnowflakeId();
  allCommentIds.push(...replyRows.map((row) => row.id), deletedReplyId);
  await db.insert(comments).values([
    ...replyRows.map((row) => ({
      id: row.id,
      content: row.content,
      postId: row.postId,
      authorId: owner,
      parentCommentId: row.parentCommentId,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      deletedAt: row.deletedAt,
    })),
    {
      id: deletedReplyId,
      content: 'f148 deleted reply by owner',
      postId: postNormal,
      authorId: owner,
      parentCommentId: null,
      createdAt: at(-180),
      updatedAt: at(-180),
      deletedAt: now,
    },
  ]);

  // Children of the reply on the normal post: one visible to everyone, one
  // by the blocked author (counted for anonymous, never for the viewer),
  // one soft-deleted (counted for nobody).
  const [childNormal, childBlocked, childDeleted] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allCommentIds.push(childNormal, childBlocked, childDeleted);
  await db.insert(comments).values([
    {
      id: childNormal,
      content: 'f148 child by normal author',
      postId: postNormal,
      authorId: normal,
      parentCommentId: rPostNormal,
      createdAt: at(-90),
      updatedAt: at(-90),
      deletedAt: null,
    },
    {
      id: childBlocked,
      content: 'f148 child by blocked author',
      postId: postNormal,
      authorId: blocked,
      parentCommentId: rPostNormal,
      createdAt: at(-80),
      updatedAt: at(-80),
      deletedAt: null,
    },
    {
      id: childDeleted,
      content: 'f148 deleted child',
      postId: postNormal,
      authorId: normal,
      parentCommentId: rPostNormal,
      createdAt: at(-70),
      updatedAt: at(-70),
      deletedAt: now,
    },
  ]);

  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.execute(sql`
    INSERT INTO "UserBlock" (id, "blockerId", "blockedId")
    VALUES (${blockRowA}, ${viewer}, ${blocked}),
           (${blockRowB}, ${blocker}, ${viewer})
  `);
  await db.execute(sql`
    INSERT INTO "UserMute" (id, "muterId", "mutedId")
    VALUES (${muteRow}, ${viewer}, ${muted})
  `);
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM "UserBlock" WHERE "blockerId" IN (${sql.join(
      allUserIds.map((id) => sql`${id}`),
      sql`, `
    )}) OR "blockedId" IN (${sql.join(
      allUserIds.map((id) => sql`${id}`),
      sql`, `
    )})
  `);
  await db.execute(sql`
    DELETE FROM "UserMute" WHERE "muterId" IN (${sql.join(
      allUserIds.map((id) => sql`${id}`),
      sql`, `
    )}) OR "mutedId" IN (${sql.join(
      allUserIds.map((id) => sql`${id}`),
      sql`, `
    )})
  `);
  if (allCommentIds.length > 0)
    await db.delete(comments).where(inArray(comments.id, allCommentIds));
  if (allPostIds.length > 0)
    await db.delete(posts).where(inArray(posts.id, allPostIds));
  if (allUserIds.length > 0)
    await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('profile replies viewer moderation', () => {
  it('anonymous reads stay unfiltered (control)', async () => {
    const { status, body } = await fetchReplies();
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    expect(res.total).toBe(8);
    expect(res.items).toHaveLength(8);
    expect(item(res, rPostBlocked).post?.content).toBe(
      'f148 post by blocked author'
    );
    expect(item(res, rPcBlocked).parentComment?.content).toBe(
      'f148 parent comment by blocked author'
    );
    expect(item(res, rPostNormal).replyCount).toBe(2);
  });

  it('hides embedded parent posts by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    // The owner's own replies are the page target: all stay listed and the
    // total still counts every visible reply.
    expect(res.total).toBe(8);
    expect(res.items).toHaveLength(8);
    expect(item(res, rPostNormal).post?.id).toBe(postNormal);
    expect(item(res, rPostBlocked).post).toBeNull();
    expect(item(res, rPostMuted).post).toBeNull();
    expect(item(res, rPostBlocker).post).toBeNull();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('f148 post by blocked author');
    expect(serialized).not.toContain('f148 post by muted author');
    expect(serialized).not.toContain('f148 post by blocking author');
  });

  it('hides embedded parent comments by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    expect(item(res, rPcNormal).parentComment?.id).toBe(pcNormal);
    expect(item(res, rPcBlocked).parentComment).toBeNull();
    expect(item(res, rPcMuted).parentComment).toBeNull();
    expect(item(res, rPcBlocker).parentComment).toBeNull();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('f148 parent comment by blocked author');
    expect(serialized).not.toContain('f148 parent comment by muted author');
    expect(serialized).not.toContain('f148 parent comment by blocking author');
  });

  it('does not count child replies by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    // Visible children of rPostNormal for the viewer: only the normal
    // author's (the blocked author's is never counted, the deleted one
    // is counted for nobody).
    expect(item(res, rPostNormal).replyCount).toBe(1);
  });
});
