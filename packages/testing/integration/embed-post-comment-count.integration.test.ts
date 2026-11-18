/**
 * PRD §§6.1/12 and MVP Phase 5: public anonymous embed/thread parity.
 * GET /api/embed/post/[id] against a real database: the commentCount in the
 * embed metadata is what a shared link preview shows, so it must count the
 * comments a visitor can actually see in the post's comment thread.
 *
 * The comment list (GET /api/posts/[id]/comments) builds a tree and omits
 * comments whose parent is not visible — a parent soft-deleted by the admin
 * content queue "hide" action takes its whole subtree out of the thread,
 * even though the replies themselves are not deleted. The embed route is
 * exercised unmodified and anonymously.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, comments, db, eq, isNull, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type EmbedResponse = {
  metadata: { likeCount: number; commentCount: number; shareCount: number };
};

type CommentTreeItem = { id: string; replies: CommentTreeItem[] };
type CommentListResponse = { data: { comments: CommentTreeItem[] } };

let authorA: string;
let authorB: string;
let postId: string;
let controlPostId: string;
function ownership() {
  return {
    users: new Map<string, typeof users.$inferSelect>(),
    posts: new Map<string, typeof posts.$inferSelect>(),
    comments: new Map<string, typeof comments.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
const ipBytes = crypto.getRandomValues(new Uint8Array(2));
const requestIp = `198.19.${ipBytes[0]}.${ipBytes[1]}`;

async function insertUsers(
  values: (typeof users.$inferInsert)[],
  receipt = owned
) {
  const rows = await db.insert(users).values(values).returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}

async function insertPosts(
  values: (typeof posts.$inferInsert)[],
  receipt = owned
) {
  const rows = await db.insert(posts).values(values).returning();
  for (const row of rows) receipt.posts.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Post RETURNING');
  return rows;
}

async function insertComments(
  values: (typeof comments.$inferInsert)[],
  receipt = owned
) {
  const rows = await db.insert(comments).values(values).returning();
  // This fixture supplies parents before children. Acquire in that explicit
  // order, independent of SQL RETURNING order, for reverse-order cleanup.
  for (const value of values) {
    const row = rows.find((inserted) => inserted.id === value.id);
    if (row) receipt.comments.set(row.id, row);
  }
  // Acquire every returned row before assertions, including unexpected rows.
  for (const row of rows) receipt.comments.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Comment RETURNING');
  return rows;
}

async function cleanup(receipt: Ownership) {
  const failures: Error[] = [];
  // Child tables and the known child-first comment order precede parents.
  // Each delete matches the acquired identity in the DELETE itself. A failed
  // statement/readback retains its receipt and does not prevent later attempts.
  const actions = [
    ...[...receipt.comments.values()].reverse().map((row) => async () => {
      await db
        .delete(comments)
        .where(
          and(
            eq(comments.id, row.id),
            eq(comments.postId, row.postId),
            eq(comments.authorId, row.authorId),
            eq(comments.content, row.content),
            row.parentCommentId === null
              ? isNull(comments.parentCommentId)
              : eq(comments.parentCommentId, row.parentCommentId),
            eq(comments.createdAt, row.createdAt)
          )
        );
      const remaining = await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.id, row.id));
      if (remaining.length) throw new Error(`Owned Comment remains: ${row.id}`);
      receipt.comments.delete(row.id);
    }),
    ...[...receipt.posts.values()].map((row) => async () => {
      await db
        .delete(posts)
        .where(
          and(
            eq(posts.id, row.id),
            eq(posts.authorId, row.authorId),
            eq(posts.content, row.content),
            eq(posts.timestamp, row.timestamp)
          )
        );
      const remaining = await db
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.id, row.id));
      if (remaining.length) throw new Error(`Owned Post remains: ${row.id}`);
      receipt.posts.delete(row.id);
    }),
    ...[...receipt.users.values()].map((row) => async () => {
      await db
        .delete(users)
        .where(
          and(
            eq(users.id, row.id),
            row.username === null
              ? isNull(users.username)
              : eq(users.username, row.username),
            eq(users.updatedAt, row.updatedAt)
          )
        );
      const remaining = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, row.id));
      if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
      receipt.users.delete(row.id);
    }),
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (Object.values(receipt).some((rows) => rows.size))
    failures.push(new Error('Owned embed rows remain after cleanup'));
  if (failures.length)
    throw new AggregateError(failures, 'Owned embed fixture cleanup failed');
}

let embedGET: typeof import('../../../apps/web/src/app/api/embed/post/[id]/route').GET;
let listGET: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').GET;

async function fetchEmbedCommentCount(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/embed/post/${id}`)
  );
  const response = await embedGET(request, {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  const body = (await response
    .json()
    .catch(() => null)) as EmbedResponse | null;
  return { status: response.status, commentCount: body?.metadata.commentCount };
}

function countTreeNodes(items: CommentTreeItem[]): number {
  let total = 0;
  for (const item of items) {
    total += 1 + countTreeNodes(item.replies);
  }
  return total;
}

async function fetchVisibleCommentCount(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${id}/comments`, {
      headers: { 'x-forwarded-for': requestIp },
    })
  );
  const response = await listGET(request, {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  const body = (await response
    .json()
    .catch(() => null)) as CommentListResponse | null;
  return {
    status: response.status,
    visible: body ? countTreeNodes(body.data.comments) : -1,
  };
}

beforeAll(async () => {
  ({ GET: embedGET } = await import(
    '../../../apps/web/src/app/api/embed/post/[id]/route'
  ));
  ({ GET: listGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  ));

  [authorA, authorB, postId, controlPostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const ids = await Promise.all(
    Array.from({ length: 9 }, () => generateSnowflakeId())
  );
  const [
    visibleRootId,
    visibleReplyId,
    hiddenRootId,
    orphanReplyId,
    orphanGrandchildId,
    deletedReplyId,
    controlRootId,
    controlReplyId,
    controlSecondRootId,
  ] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await insertUsers([
    {
      id: authorA,
      username: `test-embed-a-${authorA}`,
      displayName: 'Embed Fixture A',
      updatedAt: now,
    },
    {
      id: authorB,
      username: `test-embed-b-${authorB}`,
      displayName: 'Embed Fixture B',
      updatedAt: now,
    },
  ]);

  await insertPosts([
    {
      id: postId,
      content: 'embed fixture post',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: controlPostId,
      content: 'embed control post',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  // Main post: a visible root with a visible reply; a moderation-hidden
  // root (soft-deleted only on its own row, exactly what the admin content
  // queue hide action does) whose non-deleted reply and grandchild can
  // never be reached in the thread; one directly deleted reply.
  // Visible in the thread: 2. Non-deleted rows: 4.
  await insertComments([
    {
      id: visibleRootId,
      content: 'visible root',
      postId,
      authorId: authorA,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleReplyId,
      content: 'visible reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: hiddenRootId,
      content: 'hidden root',
      postId,
      authorId: authorB,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: now,
    },
    {
      id: orphanReplyId,
      content: 'reply under hidden root',
      postId,
      authorId: authorA,
      parentCommentId: hiddenRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: orphanGrandchildId,
      content: 'grandchild under hidden root',
      postId,
      authorId: authorA,
      parentCommentId: orphanReplyId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: deletedReplyId,
      content: 'directly deleted reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
    // Control post: three fully visible comments.
    {
      id: controlRootId,
      content: 'control root',
      postId: controlPostId,
      authorId: authorA,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: controlReplyId,
      content: 'control reply',
      postId: controlPostId,
      authorId: authorB,
      parentCommentId: controlRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: controlSecondRootId,
      content: 'control second root',
      postId: controlPostId,
      authorId: authorB,
      parentCommentId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);
});

afterAll(async () => cleanup(owned));

describe('GET /api/embed/post/[id] commentCount', () => {
  it('counts only the comments the comment thread can show', async () => {
    const { visible } = await fetchVisibleCommentCount(postId);
    expect(visible).toBe(2);

    const { status, commentCount } = await fetchEmbedCommentCount(postId);
    expect(status).toBe(200);
    expect(commentCount).toBe(visible);
  });

  it('still counts every visible comment on an unmoderated post', async () => {
    const { visible } = await fetchVisibleCommentCount(controlPostId);
    expect(visible).toBe(3);

    const { status, commentCount } =
      await fetchEmbedCommentCount(controlPostId);
    expect(status).toBe(200);
    expect(commentCount).toBe(3);
  });

  it('cleans real partial inserts without owning a colliding control', async () => {
    const partial = ownership();
    const control = ownership();
    const [controlId, partialId, partialPostId, partialCommentId] =
      await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);
    const now = new Date();
    try {
      await insertUsers(
        [
          {
            id: controlId,
            username: `embed-survivor-${controlId}`,
            updatedAt: now,
          },
        ],
        control
      );
      const before = await db
        .select()
        .from(users)
        .where(eq(users.id, controlId));
      expect(before).toHaveLength(1);
      await insertUsers(
        [
          {
            id: partialId,
            username: `embed-partial-${partialId}`,
            updatedAt: now,
          },
        ],
        partial
      );
      await insertPosts(
        [
          {
            id: partialPostId,
            authorId: partialId,
            content: 'owned partial post',
            timestamp: now,
            createdAt: now,
          },
        ],
        partial
      );
      await insertComments(
        [
          {
            id: partialCommentId,
            postId: partialPostId,
            authorId: partialId,
            content: 'owned partial comment',
            parentCommentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        partial
      );
      await expect(
        insertUsers(
          [
            {
              id: controlId,
              username: `embed-collision-${partialId}`,
              updatedAt: now,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect([...partial.users.keys()]).toEqual([partialId]);
      expect([...partial.posts.keys()]).toEqual([partialPostId]);
      expect([...partial.comments.keys()]).toEqual([partialCommentId]);
      await cleanup(partial);
      expect(Object.values(partial).every((rows) => rows.size === 0)).toBe(
        true
      );
      expect(
        await db.select().from(users).where(eq(users.id, controlId))
      ).toEqual(before);
      await cleanup(partial); // Successful cleanup is safe to repeat.
    } finally {
      const results = await Promise.allSettled([
        cleanup(partial),
        cleanup(control),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ]
          : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Partial embed cleanup failed');
    }
  });
});
