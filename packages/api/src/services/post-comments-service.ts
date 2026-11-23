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

  // Traverse only IDs and timestamps. Load content only for the selected page.
  const pageIds = sql`(
    WITH RECURSIVE visible_comments(id, "createdAt") AS (
      SELECT ${comments.id}, ${comments.createdAt}
      FROM ${comments}
      WHERE ${eligible} AND ${comments.parentCommentId} IS NULL
      UNION ALL
      SELECT ${comments.id}, ${comments.createdAt}
      FROM ${comments}
      JOIN visible_comments ON ${comments.parentCommentId} = visible_comments.id
      WHERE ${eligible}
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
