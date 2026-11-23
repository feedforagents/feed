import { eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from './client';
import { dbWrite, type Transaction } from './db';
import { comments, reactions } from './schema/posts';

async function lockPostComments(tx: Transaction, postId: string) {
  // Take this lock before reading the parent or walking the subtree. A reply
  // committed before the delete acquires the lock belongs to that deletion.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'comment-thread:' + postId}))`
  );
}

type CommentInsert = typeof comments.$inferInsert;

export async function createCommentWithParentCheck(
  data: CommentInsert,
  client: DrizzleClient = dbWrite
) {
  async function insert(writer: Pick<DrizzleClient, 'insert'>) {
    const [comment] = await writer.insert(comments).values(data).returning();
    if (!comment) throw new Error('Comment insert returned no row');
    return { status: 'created' as const, comment };
  }

  const { postId, parentCommentId } = data;
  if (parentCommentId == null) return insert(client);

  return client.transaction(async (tx) => {
    await lockPostComments(tx, postId);
    const [parent] = await tx
      .select({ postId: comments.postId, deletedAt: comments.deletedAt })
      .from(comments)
      .where(eq(comments.id, parentCommentId))
      .limit(1);

    if (!parent) return { status: 'parent-missing' as const };
    if (parent.deletedAt) return { status: 'parent-deleted' as const };
    if (parent.postId !== postId)
      return { status: 'parent-post-mismatch' as const };
    return insert(tx);
  });
}

export async function deleteCommentSubtree(
  commentId: string,
  authorId: string
) {
  return dbWrite.transaction(async (tx) => {
    const findComment = async () => {
      const [comment] = await tx
        .select({ postId: comments.postId, authorId: comments.authorId })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1);
      return comment;
    };

    const comment = await findComment();
    if (!comment) return { status: 'not-found' as const };
    if (comment.authorId !== authorId) return { status: 'forbidden' as const };

    await lockPostComments(tx, comment.postId);
    const lockedComment = await findComment();
    if (!lockedComment) return { status: 'not-found' as const };
    if (lockedComment.authorId !== authorId)
      return { status: 'forbidden' as const };

    // UNION visits each ID once, even if a legacy thread contains a cycle.
    // Keep the subtree on the server so its size never affects the bind count.
    const [deleted] = await tx.execute<{ count: number }>(sql`
      WITH RECURSIVE subtree(id) AS (
        SELECT ${comments.id} FROM ${comments}
        WHERE ${comments.id} = ${commentId} AND ${comments.postId} = ${comment.postId}
        UNION
        SELECT child.id FROM "Comment" AS child
        JOIN subtree ON child."parentCommentId" = subtree.id
        WHERE child."postId" = ${comment.postId}
      ), deleted_reactions AS (
        DELETE FROM ${reactions} WHERE ${reactions.commentId} IN (SELECT id FROM subtree)
      ), deleted_comments AS (
        DELETE FROM ${comments} WHERE ${comments.id} IN (SELECT id FROM subtree)
        RETURNING 1
      )
      SELECT count(*)::integer AS count FROM deleted_comments
    `);

    if (!deleted?.count) return { status: 'not-found' as const };
    return { status: 'deleted' as const, repliesCount: deleted.count - 1 };
  });
}
