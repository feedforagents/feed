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

// A comment is reachable only through visible parents rooted on its post.
function reachablePostComments(postIds: string[], excludedIds: string[]) {
  const eligible = and(
    inArray(comments.postId, postIds),
    isNull(comments.deletedAt),
    excludedIds.length > 0
      ? notInArray(comments.authorId, excludedIds)
      : undefined
  );
  // Materialize the posts' eligible rows once so a wide thread cannot make
  // the recursive join traverse the global parent-comment index.
  return sql`
    WITH RECURSIVE eligible_comments AS MATERIALIZED (
      SELECT ${comments.id}, ${comments.postId}, ${comments.createdAt}, ${comments.parentCommentId}
      FROM ${comments}
      WHERE ${eligible}
    ),
    visible_comments(id, "postId", "createdAt") AS (
      SELECT id, "postId", "createdAt"
      FROM eligible_comments
      WHERE "parentCommentId" IS NULL
      UNION ALL
      SELECT child.id, child."postId", child."createdAt"
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
    ${reachablePostComments([postId], excludedIds)}
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
    ${reachablePostComments([postId], excludedIds)}
    SELECT count(*)::text AS count FROM visible_comments
  `);
  return Number(result?.count ?? 0);
}

/**
 * Count the reachable comment tree for many posts in one query, keyed by
 * post id. Every requested post appears in the map (0 when it has no
 * reachable comment). This is the list counterpart of
 * countReachablePostComments: a post card must promise only what the
 * detail screen shows for the same viewer.
 *
 * Each post walks only its own eligible rows (LATERAL per-post CTE), so
 * one deep thread costs (its depth x its rows), not (max depth x the
 * whole page's rows) — a single 1000-deep chain used to make the
 * batched walk scan every comment on the page at every depth.
 */
export async function countReachablePostCommentsForPosts(
  postIds: string[],
  excludedIds: string[]
): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map();
  // Parameterize the id list once, as in the feed pipelines.
  const postIdsArray = sql`ARRAY[${sql.join(
    postIds.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`;
  const rows = await db.execute<{ postId: string; count: string }>(sql`
    WITH target_posts AS (
      SELECT unnest(${postIdsArray}) AS "postId"
    )
    SELECT tp."postId" AS "postId", count(visible.id)::text AS count
    FROM target_posts tp
    LEFT JOIN LATERAL (
      WITH RECURSIVE eligible_comments AS MATERIALIZED (
        SELECT ${comments.id}, ${comments.createdAt}, ${comments.parentCommentId}
        FROM ${comments}
        WHERE ${and(
          sql`${comments.postId} = tp."postId"`,
          isNull(comments.deletedAt),
          excludedIds.length > 0
            ? notInArray(comments.authorId, excludedIds)
            : undefined
        )}
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
    ) visible ON true
    GROUP BY tp."postId"
  `);
  return new Map(rows.map((row) => [row.postId, Number(row.count)]));
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
