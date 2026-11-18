/** PRD §6.1/§12, MVP phase 5: existing public and moderated reply reads. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  comments,
  db,
  eq,
  inArray,
  posts,
  reactions,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
interface CommentNode {
  id: string;
  userId: string;
  parentCommentId: string | null;
  parentCommentAuthorName?: string;
  likeCount: number;
  isLiked: boolean;
  replies: CommentNode[];
}
const nodeSchema: z.ZodType<CommentNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    userId: z.string(),
    parentCommentId: z.string().nullable(),
    parentCommentAuthorName: z.string().optional(),
    likeCount: z.number(),
    isLiked: z.boolean(),
    replies: z.array(nodeSchema),
  })
);
const responseSchema = z.object({
  data: z.object({ comments: z.array(nodeSchema), total: z.number() }),
});
const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  reactions: new Set<string>(),
  blocks: new Set<string>(),
  mutes: new Set<string>(),
};
let author = '',
  viewer = '',
  normal = '',
  blocked = '',
  muted = '',
  blocker = '',
  post = '',
  emptyPost = '',
  deletedPost = '',
  futurePost = '',
  missingPost = '',
  stewardId = '',
  normalRoot = '',
  normalReply = '',
  grandchild = '',
  ownRoot = '',
  mutedRoot = '',
  mutedReply = '',
  muteId = '',
  token = '';
const publicIds: string[] = [];

async function insertUsers(
  rows: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  for (const row of inserted) ownership.add(row.id);
}
async function cleanUsers(ownership: Set<string>) {
  if (ownership.size)
    await db.delete(users).where(inArray(users.id, [...ownership]));
}
function flatten(nodes: CommentNode[]): CommentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.replies)]);
}
async function get(headers: Record<string, string> = {}, id = post) {
  const response = await fetch(`${baseUrl}/api/posts/${id}/comments`, {
    headers,
    cache: 'no-store',
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  return {
    response,
    data: responseSchema.parse(await response.json()).data,
  };
}
function signed() {
  return { authorization: `Bearer ${token}` };
}
function ids(nodes: CommentNode[]) {
  return flatten(nodes)
    .map((node) => node.id)
    .sort();
}

beforeAll(async () => {
  const now = new Date();
  author = await generateSnowflakeId();
  viewer = await generateSnowflakeId();
  normal = await generateSnowflakeId();
  blocked = await generateSnowflakeId();
  muted = await generateSnowflakeId();
  blocker = await generateSnowflakeId();
  stewardId = `comment-viewer-${viewer}`;
  await insertUsers(
    [author, viewer, normal, blocked, muted, blocker].map((id) => ({
      id,
      username: `comment-viewer-${id}`,
      displayName: `Comment author ${id}`,
      stewardId: id === viewer ? stewardId : null,
      updatedAt: now,
    }))
  );
  post = await generateSnowflakeId();
  emptyPost = await generateSnowflakeId();
  deletedPost = await generateSnowflakeId();
  futurePost = await generateSnowflakeId();
  missingPost = await generateSnowflakeId();
  const insertedPosts = await db
    .insert(posts)
    .values(
      [post, emptyPost, deletedPost, futurePost].map((id) => ({
        id,
        authorId: author,
        content: `Comment moderation fixture ${id}`,
        timestamp: new Date(
          now.getTime() + (id === futurePost ? 86_400_000 : -3_600_000)
        ),
        deletedAt: id === deletedPost ? now : null,
      }))
    )
    .returning({ id: posts.id });
  for (const row of insertedPosts) owned.posts.add(row.id);
  const rows: Array<typeof comments.$inferInsert> = [];
  async function comment(
    authorId: string,
    parentCommentId: string | null = null,
    shown = true,
    deleted = false
  ) {
    const id = await generateSnowflakeId();
    rows.push({
      id,
      postId: post,
      authorId,
      parentCommentId,
      content: `Comment fixture ${id}`,
      createdAt: new Date(now.getTime() - 60_000 + rows.length),
      updatedAt: now,
      deletedAt: deleted ? now : null,
    });
    if (shown) publicIds.push(id);
    return id;
  }
  normalRoot = await comment(normal);
  const blockedRoot = await comment(blocked);
  mutedRoot = await comment(muted);
  const blockerRoot = await comment(blocker);
  ownRoot = await comment(viewer);
  normalReply = await comment(author, normalRoot);
  grandchild = await comment(normal, normalReply);
  await comment(normal, blockedRoot);
  mutedReply = await comment(normal, mutedRoot);
  await comment(normal, blockerRoot);
  const deletedRoot = await comment(normal, null, false, true);
  await comment(normal, deletedRoot, false);
  await comment(normal, await generateSnowflakeId(), false);
  await comment(normal, normalRoot, false, true);
  const insertedComments = await db
    .insert(comments)
    .values(rows)
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      {
        id: await generateSnowflakeId(),
        blockerId: viewer,
        blockedId: blocked,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: blocker,
        blockedId: viewer,
      },
    ])
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) owned.blocks.add(row.id);
  muteId = await generateSnowflakeId();
  const insertedMutes = await db
    .insert(userMutes)
    .values({ id: muteId, muterId: viewer, mutedId: muted })
    .returning({ id: userMutes.id });
  for (const row of insertedMutes) owned.mutes.add(row.id);
  const insertedReactions = await db
    .insert(reactions)
    .values([
      {
        id: await generateSnowflakeId(),
        commentId: normalRoot,
        userId: viewer,
        type: 'like',
      },
      {
        id: await generateSnowflakeId(),
        commentId: normalRoot,
        userId: author,
        type: 'like',
      },
    ])
    .returning({ id: reactions.id });
  for (const row of insertedReactions) owned.reactions.add(row.id);
  token = await createStewardTestToken(stewardId);
});

afterAll(async () => {
  if (owned.reactions.size)
    await db
      .delete(reactions)
      .where(inArray(reactions.id, [...owned.reactions]));
  if (owned.blocks.size)
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.id, [...owned.blocks]));
  if (owned.mutes.size)
    await db.delete(userMutes).where(inArray(userMutes.id, [...owned.mutes]));
  if (owned.comments.size)
    await db.delete(comments).where(inArray(comments.id, [...owned.comments]));
  if (owned.posts.size)
    await db.delete(posts).where(inArray(posts.id, [...owned.posts]));
  await cleanUsers(owned.users);
});

test('anonymous readers count only reachable comments from visible authors', async () => {
  const { data } = await get();
  expect(ids(data.comments)).toEqual([...publicIds].sort());
  expect(data.total).toBe(10);
  const root = flatten(data.comments).find((node) => node.id === normalRoot);
  assert.ok(root);
  expect(root.likeCount).toBe(2);
  expect(root.isLiked).toBe(false);
});
test('bearer viewer hides all three moderation directions before building the tree', async () => {
  const { data, response } = await get(signed());
  expect(ids(data.comments)).toEqual(
    [normalRoot, normalReply, grandchild, ownRoot].sort()
  );
  expect(data.total).toBe(4);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(
    flatten(data.comments).some((node) =>
      [blocked, muted, blocker].includes(node.userId)
    )
  ).toBe(false);
  const root = flatten(data.comments).find((node) => node.id === normalRoot);
  assert.ok(root);
  expect(root.likeCount).toBe(2);
  expect(root.isLiked).toBe(true);
  expect(
    flatten(data.comments).find((node) => node.id === normalReply)
      ?.parentCommentAuthorName
  ).toBe(`Comment author ${normal}`);
});
test('cookie credentials resolve the same viewer without changing anonymous reads', async () => {
  const { data } = await get({ cookie: `steward-token=${token}` });
  expect(ids(data.comments)).toEqual(
    [normalRoot, normalReply, grandchild, ownRoot].sort()
  );
  expect(data.total).toBe(4);
  expect(ids((await get()).data.comments)).toEqual([...publicIds].sort());
});
test('invalid optional credentials and development headers retain the public view', async () => {
  const headerCases: Array<Record<string, string>> = [
    { authorization: 'Bearer invalid-token' },
    { 'x-dev-user-id': viewer },
  ];
  for (const headers of headerCases) {
    const { data } = await get(headers);
    expect(ids(data.comments)).toEqual([...publicIds].sort());
    expect(data.total).toBe(10);
  }
});
test('same-URL viewer reads follow owned mute removal and restoration', async () => {
  const removed = await db
    .delete(userMutes)
    .where(eq(userMutes.id, muteId))
    .returning({ id: userMutes.id });
  assert.equal(removed.length, 1);
  owned.mutes.delete(muteId);
  try {
    const { data } = await get(signed());
    expect(ids(data.comments)).toEqual(
      [
        normalRoot,
        normalReply,
        grandchild,
        ownRoot,
        mutedRoot,
        mutedReply,
      ].sort()
    );
    expect(data.total).toBe(6);
  } finally {
    const restored = await db
      .insert(userMutes)
      .values({ id: muteId, muterId: viewer, mutedId: muted })
      .returning({ id: userMutes.id });
    for (const row of restored) owned.mutes.add(row.id);
  }
  expect((await get(signed())).data.total).toBe(4);
});
test('soft-deleting an owned root hides its descendants without reparenting', async () => {
  await db
    .update(comments)
    .set({ deletedAt: new Date() })
    .where(eq(comments.id, normalRoot));
  try {
    const { data } = await get(signed());
    expect(ids(data.comments)).toEqual([ownRoot]);
    expect(data.total).toBe(1);
  } finally {
    await db
      .update(comments)
      .set({ deletedAt: null })
      .where(eq(comments.id, normalRoot));
  }
});
test('keeps empty-thread and missing, deleted, future post guards', async () => {
  const empty = await get(signed(), emptyPost);
  expect(empty.data).toEqual({ comments: [], total: 0 });
  for (const id of [missingPost, deletedPost, futurePost]) {
    const response = await fetch(`${baseUrl}/api/posts/${id}/comments`, {
      headers: signed(),
    });
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  }
});
test('failed setup owns no existing user and cannot overwrite its identity', async () => {
  const failedOwnership = new Set<string>();
  await expect(
    insertUsers(
      [{ id: viewer, stewardId: 'must-not-replace', updatedAt: new Date() }],
      failedOwnership
    )
  ).rejects.toThrow();
  expect(failedOwnership.size).toBe(0);
  await cleanUsers(failedOwnership);
  const [existing] = await db
    .select({ stewardId: users.stewardId })
    .from(users)
    .where(eq(users.id, viewer));
  expect(existing?.stewardId).toBe(stewardId);
});
