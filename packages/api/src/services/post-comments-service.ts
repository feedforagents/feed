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

async function excludedCommentAuthors(viewerId: string | undefined) {
  if (!viewerId) return [];
  const exclusions = await Promise.all([
    getBlockedUserIds(viewerId),
    getMutedUserIds(viewerId),
    getBlockedByUserIds(viewerId),
  ]);
  return [...new Set(exclusions.flat())];
}

// A comment is reachable only through visible parents rooted on this post.
function reachablePostComments(postId: string, excludedIds: string[]) {
  const eligible = and(
    eq(comments.postId, postId),
    isNull(comments.deletedAt),
    excludedIds.length > 0
      ? notInArray(comments.authorId, excludedIds)
      : undefined
  );
  // Materialize the post's eligible rows once so a wide thread cannot make
  // the recursive join traverse the global parent-comment index.
  return sql`
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
  `;
}

/** Select one flat page of the comment tree visible on the web. */
export async function listVisiblePostComments(
  postId: string,
  viewerId: string | undefined,
  limit: number,
  direction: 'asc' | 'desc'
) {
  const excludedIds = await excludedCommentAuthors(viewerId);
  const order = direction === 'asc' ? sql`ASC` : sql`DESC`;
  const orderBy = direction === 'asc' ? asc : desc;

  // Traverse only IDs and timestamps. Load content only for the selected page.
  const pageIds = sql`(
    ${reachablePostComments(postId, excludedIds)}
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

/** Count the reachable comment tree using already resolved author exclusions. */
export async function countReachablePostComments(
  postId: string,
  excludedIds: string[]
): Promise<number> {
  const [result] = await db.execute<{ count: string }>(sql`
    ${reachablePostComments(postId, excludedIds)}
    SELECT count(*)::text AS count FROM visible_comments
  `);
  return Number(result?.count ?? 0);
}

/** Count the same visible tree as the comment list, without returning its rows. */
export async function countVisiblePostComments(
  postId: string,
  viewerId: string,
  anonymousCount: number
): Promise<number> {
  const excludedIds = await excludedCommentAuthors(viewerId);
  // The public post detail already counted all branches this viewer can see.
  if (excludedIds.length === 0) return anonymousCount;

  return countReachablePostComments(postId, excludedIds);
}
