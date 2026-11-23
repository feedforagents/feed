import {
  and,
  asc,
  comments,
  db,
  desc,
  eq,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  inArray,
  isNull,
  notInArray,
  sql,
} from '@feed/db';

/**
 * Select one flat page of the comment tree visible on the web. A reply can
 * enter the page only through a visible root and a continuous chain of
 * visible parents on this post.
 */
export async function listVisiblePostComments(
  postId: string,
  viewerId: string | undefined,
  limit: number,
  direction: 'asc' | 'desc'
) {
  const exclusions = viewerId
    ? await Promise.all([
        getBlockedUserIds(viewerId),
        getMutedUserIds(viewerId),
        getBlockedByUserIds(viewerId),
      ])
    : [];
  const excludedIds = [...new Set(exclusions.flat())];
  const eligible = and(
    eq(comments.postId, postId),
    isNull(comments.deletedAt),
    excludedIds.length > 0
      ? notInArray(comments.authorId, excludedIds)
      : undefined
  );
  const order = direction === 'asc' ? sql`ASC` : sql`DESC`;
  const orderBy = direction === 'asc' ? asc : desc;

  // Materialize this post's eligible rows so the recursive join never scans
  // unrelated comments. Load content only for the selected page.
  const pageIds = sql`(
    WITH RECURSIVE eligible_comments AS MATERIALIZED (
      SELECT ${comments.id}, ${comments.createdAt}, ${comments.parentCommentId}
      FROM ${comments}
      WHERE ${eligible}
    ),
    visible_comments(id, "createdAt") AS (
      SELECT id, "createdAt"
      FROM eligible_comments
      WHERE "parentCommentId" IS NULL
      UNION ALL
      SELECT child.id, child."createdAt"
      FROM eligible_comments child
      JOIN visible_comments parent ON child."parentCommentId" = parent.id
    )
    SELECT id FROM visible_comments
    ORDER BY "createdAt" ${order}, id ${order}
    LIMIT ${limit}
  )`;

  return db
    .select({
      id: comments.id,
      postId: comments.postId,
      authorId: comments.authorId,
      content: comments.content,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(and(eq(comments.postId, postId), inArray(comments.id, pageIds)))
    .orderBy(orderBy(comments.createdAt), orderBy(comments.id));
}
