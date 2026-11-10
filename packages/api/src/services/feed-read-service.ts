import type { Post } from '@feed/db';
import {
  and,
  db,
  desc,
  encodePostCursor,
  eq,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  inArray,
  isNull,
  lte,
  postCursorConditions,
  posts,
  sql,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, toISO } from '@feed/shared';
import { cachedDb } from '../cache';

/**
 * Engagement thresholds for comment preview visibility
 * These control when and how many comment previews are shown based on post engagement
 */
const ENGAGEMENT_THRESHOLDS = {
  // Comment count thresholds
  COMMENTS_HIGH: 50, // Show 2 previews, always visible
  COMMENTS_MEDIUM: 20, // Show 1 preview, always visible
  COMMENTS_LOW: 10, // Show 1 preview, 85% visibility
  COMMENTS_MINIMAL: 5, // Show 1 preview, 65% visibility
  COMMENTS_VERY_LOW: 2, // Show 1 preview, 40-60% visibility

  // Like count thresholds (alternative trigger)
  LIKES_MEDIUM: 30, // Show 1 preview, always visible
  LIKES_LOW: 15, // Show 1 preview, 85% visibility
  LIKES_MINIMAL: 8, // Show 1 preview, 65% visibility
  LIKES_VERY_LOW: 3, // Show 1 preview, 40-60% visibility

  // Top comment like thresholds
  TOP_COMMENT_LIKES_BOOST: 2, // Boosts visibility probability

  // Visibility probabilities (out of 100)
  VISIBILITY_ALWAYS: 100,
  VISIBILITY_HIGH: 85,
  VISIBILITY_MEDIUM: 65,
  VISIBILITY_LOW_WITH_LIKES: 60,
  VISIBILITY_LOW_NO_LIKES: 40,
  VISIBILITY_MINIMAL_WITH_LIKES: 50,
  VISIBILITY_MINIMAL_NO_LIKES: 25,
} as const;

// Type for posts with included original post relation
type PostWithOriginal = Post & {
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
    createdAt: Date;
    deletedAt: Date | null;
  } | null;
};

interface CommentPreviewRow {
  id: string;
  postId: string;
  content: string;
  createdAt: Date;
  authorId: string;
  userName: string | null;
  userUsername: string | null;
  userAvatar: string | null;
  likeCount: number;
  rowNum: number;
}

/**
 * Fetch all post metadata in a single consolidated CTE query
 * This replaces 4+ separate queries with one optimized query
 *
 * @param postIds - Array of post IDs to fetch metadata for
 * @returns Maps for reactions, comments, shares, and comment previews
 */
async function fetchPostMetadataConsolidated(postIds: string[]): Promise<{
  reactionMap: Map<string, number>;
  commentMap: Map<string, number>;
  shareMap: Map<string, number>;
  commentPreviewMap: Map<string, CommentPreviewRow[]>;
}> {
  if (postIds.length === 0) {
    return {
      reactionMap: new Map(),
      commentMap: new Map(),
      shareMap: new Map(),
      commentPreviewMap: new Map(),
    };
  }

  // Use parameterized array for SQL safety (fixes sql.raw injection risk)
  // Build the array only once - subsequent CTEs reference target_posts
  const postIdsArray = sql`ARRAY[${sql.join(
    postIds.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`;

  // Single CTE query that fetches all interaction counts and comment previews
  // OPTIMIZATION: The array is parameterized once in target_posts CTE,
  // then referenced via JOIN to avoid duplicate parameters
  const result = await db.execute(sql`
    WITH
    -- Post IDs we're querying (parameterized for safety, defined once)
    target_posts AS (
      SELECT unnest(${postIdsArray}) AS post_id
    ),
    -- Reaction counts (likes) - JOIN to target_posts instead of ANY()
    reaction_counts AS (
      SELECT
        r."postId" as post_id,
        COUNT(*) as count
      FROM "Reaction" r
      INNER JOIN target_posts tp ON r."postId" = tp.post_id
      WHERE r.type = 'like'
      GROUP BY r."postId"
    ),
    -- Comment counts - JOIN to target_posts
    comment_counts AS (
      SELECT
        c."postId" as post_id,
        COUNT(*) as count
      FROM "Comment" c
      INNER JOIN target_posts tp ON c."postId" = tp.post_id
      WHERE c."deletedAt" IS NULL
      GROUP BY c."postId"
    ),
    -- Share counts - JOIN to target_posts
    share_counts AS (
      SELECT
        s."postId" as post_id,
        COUNT(*) as count
      FROM "Share" s
      INNER JOIN target_posts tp ON s."postId" = tp.post_id
      GROUP BY s."postId"
    ),
    -- Top comments per post with likes (window function for per-post limiting)
    ranked_comments AS (
      SELECT
        c.id,
        c."postId" as post_id,
        c.content,
        c."createdAt" as created_at,
        c."authorId" as author_id,
        u."displayName" as user_name,
        u.username as user_username,
        u."profileImageUrl" as user_avatar,
        COALESCE(cl.like_count, 0) as like_count,
        ROW_NUMBER() OVER (
          PARTITION BY c."postId"
          ORDER BY COALESCE(cl.like_count, 0) DESC, c."createdAt" DESC
        ) as rn
      FROM "Comment" c
      INNER JOIN target_posts tp ON c."postId" = tp.post_id
      LEFT JOIN "User" u ON c."authorId" = u.id
      -- Scope comment likes to only comments from target_posts to avoid full table scan
      LEFT JOIN (
        SELECT r."commentId", COUNT(*) as like_count
        FROM "Reaction" r
        INNER JOIN "Comment" c2 ON r."commentId" = c2.id
        INNER JOIN target_posts tp2 ON c2."postId" = tp2.post_id
        WHERE r."commentId" IS NOT NULL AND r.type = 'like'
        GROUP BY r."commentId"
      ) cl ON c.id = cl."commentId"
      WHERE c."parentCommentId" IS NULL
        AND c."deletedAt" IS NULL
    ),
    -- Combined results
    post_metadata AS (
      SELECT
        tp.post_id,
        COALESCE(rc.count, 0) as like_count,
        COALESCE(cc.count, 0) as comment_count,
        COALESCE(sc.count, 0) as share_count
      FROM target_posts tp
      LEFT JOIN reaction_counts rc ON tp.post_id = rc.post_id
      LEFT JOIN comment_counts cc ON tp.post_id = cc.post_id
      LEFT JOIN share_counts sc ON tp.post_id = sc.post_id
    )
    -- Return both metadata and top comments in one result set
    SELECT
      'metadata' as result_type,
      pm.post_id,
      pm.like_count::int,
      pm.comment_count::int,
      pm.share_count::int,
      NULL as comment_id,
      NULL as comment_content,
      NULL as comment_created_at,
      NULL as comment_author_id,
      NULL as comment_user_name,
      NULL as comment_user_username,
      NULL as comment_user_avatar,
      NULL::int as comment_like_count,
      NULL::int as comment_row_num
    FROM post_metadata pm
    UNION ALL
    SELECT
      'comment' as result_type,
      rc.post_id,
      0 as like_count,
      0 as comment_count,
      0 as share_count,
      rc.id as comment_id,
      rc.content as comment_content,
      rc.created_at as comment_created_at,
      rc.author_id as comment_author_id,
      rc.user_name as comment_user_name,
      rc.user_username as comment_user_username,
      rc.user_avatar as comment_user_avatar,
      rc.like_count::int as comment_like_count,
      rc.rn::int as comment_row_num
    FROM ranked_comments rc
    WHERE rc.rn <= 3
  `);

  // Parse results into separate maps
  const reactionMap = new Map<string, number>();
  const commentMap = new Map<string, number>();
  const shareMap = new Map<string, number>();
  const commentPreviewMap = new Map<string, CommentPreviewRow[]>();

  interface RawResultRow {
    result_type: string;
    post_id: string;
    like_count: number;
    comment_count: number;
    share_count: number;
    comment_id: string | null;
    comment_content: string | null;
    comment_created_at: Date | null;
    comment_author_id: string | null;
    comment_user_name: string | null;
    comment_user_username: string | null;
    comment_user_avatar: string | null;
    comment_like_count: number | null;
    comment_row_num: number | null;
  }

  // Type guard to validate raw SQL results have expected shape
  function isRawResultRow(row: unknown): row is RawResultRow {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return (
      typeof r.result_type === 'string' &&
      typeof r.post_id === 'string' &&
      (r.result_type === 'metadata' || r.result_type === 'comment')
    );
  }

  // Process results with type guard validation
  const rows = Array.isArray(result) ? result : [];
  for (const row of rows) {
    if (!isRawResultRow(row)) continue;
    if (row.result_type === 'metadata') {
      reactionMap.set(row.post_id, Number(row.like_count));
      commentMap.set(row.post_id, Number(row.comment_count));
      shareMap.set(row.post_id, Number(row.share_count));
    } else if (row.result_type === 'comment' && row.comment_id) {
      const previews = commentPreviewMap.get(row.post_id) ?? [];
      previews.push({
        id: row.comment_id,
        postId: row.post_id,
        content: row.comment_content ?? '',
        createdAt: row.comment_created_at ?? new Date(),
        authorId: row.comment_author_id ?? '',
        userName: row.comment_user_name,
        userUsername: row.comment_user_username,
        userAvatar: row.comment_user_avatar,
        likeCount: row.comment_like_count ?? 0,
        rowNum: row.comment_row_num ?? 1,
      });
      commentPreviewMap.set(row.post_id, previews);
    }
  }

  // Sort each post's comment previews by rowNum to ensure correct ordering
  // (SQL window function order may not be preserved across result set)
  for (const [postId, previews] of commentPreviewMap) {
    previews.sort((a, b) => Number(a.rowNum) - Number(b.rowNum));
    commentPreviewMap.set(postId, previews);
  }

  return { reactionMap, commentMap, shareMap, commentPreviewMap };
}

/**
 * Converts a date value to ISO string format, handling various input types.
 *
 * @param date - Date object, ISO string, or null/undefined
 * @returns ISO string representation of the date, or current date ISO string if invalid/null
 */
export function toFeedISOString(
  date: Date | string | null | undefined
): string {
  if (!date) {
    return new Date().toISOString();
  }
  if (date instanceof Date) {
    return toISO(date);
  }
  if (typeof date === 'string') {
    // If it's already an ISO string, return it
    if (date.includes('T') && date.includes('Z')) {
      return date;
    }
    // Try to parse and convert
    const parsed = new Date(date);
    if (!isNaN(parsed.getTime())) {
      return toISO(parsed);
    }
  }
  // Fallback to current date
  return new Date().toISOString();
}

export interface PostsFeedInput {
  limit: number;
  cursor?: string;
  actorId?: string;
  type?: string;
  /** Canonical account supplied by the authenticated adapter only. */
  viewerId?: string;
}

/** Canonical non-following feed shared by the web route and public Latest MCP.
 * Existing REST actor/type filters remain adapter-selected; MCP exposes Latest only. */
export async function getPostsFeed({
  limit,
  cursor,
  actorId,
  type,
  viewerId,
}: PostsFeedInput) {
  // Get posts from database with cursor-based pagination
  let postsResult: Post[];

  logger.info(
    'Fetching posts from database',
    { limit, cursor, actorId, type },
    'GET /api/posts'
  );

  if (type) {
    // Filter by type (e.g., 'article')
    logger.info(
      'Filtering posts by type',
      { type, limit, cursor },
      'GET /api/posts'
    );

    const now = new Date();

    // Build conditions
    const conditions = [eq(posts.type, type), isNull(posts.deletedAt)];

    if (cursor) {
      conditions.push(...(await postCursorConditions(cursor)));
    }
    conditions.push(lte(posts.timestamp, now)); // No future posts

    postsResult = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.timestamp), desc(posts.id))
      .limit(limit);

    logger.info(
      'Fetched posts by type',
      { type, count: postsResult.length },
      'GET /api/posts'
    );
  } else if (actorId) {
    // Get posts by specific actor (cached with cursor)
    postsResult = await cachedDb.getPostsByActor(actorId, limit, cursor);
    logger.info(
      'Fetched posts by actor (cached)',
      { actorId, count: postsResult.length },
      'GET /api/posts'
    );
  } else {
    // Get recent posts with cursor-based pagination
    postsResult = await cachedDb.getRecentPosts(limit, cursor);
    logger.info(
      'Fetched recent posts (cached)',
      { count: postsResult.length, limit, cursor },
      'GET /api/posts'
    );
  }

  // Log post structure for debugging
  if (postsResult.length > 0) {
    const samplePost = postsResult[0];
    if (samplePost) {
      logger.debug(
        'Sample post structure',
        {
          id: samplePost.id,
          hasTimestamp: !!samplePost.timestamp,
          timestampType: typeof samplePost.timestamp,
          timestampValue: samplePost.timestamp,
          hasCreatedAt: !!samplePost.createdAt,
          createdAtType: typeof samplePost.createdAt,
          createdAtValue: samplePost.createdAt,
        },
        'GET /api/posts'
      );
    }
  }

  // Pagination follows the fetched window, including rows hidden by moderation.
  // A fully filtered window must still let the caller reach older visible posts.
  const fetchedWindow = postsResult;

  // Apply moderation filters only for authenticated user (use auth identity, not query param)
  const filterUserId = viewerId;
  const excludedUserIds = new Set<string>();
  if (filterUserId) {
    const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
      getBlockedUserIds(filterUserId),
      getMutedUserIds(filterUserId),
      getBlockedByUserIds(filterUserId),
    ]);

    for (const id of [...blockedIds, ...mutedIds, ...blockedByIds])
      excludedUserIds.add(id);
    postsResult = postsResult.filter(
      (post) => !excludedUserIds.has(post.authorId)
    );
  }

  // Get original posts for reposts
  const originalPostIds = postsResult
    .filter((p) => p.originalPostId)
    .map((p) => p.originalPostId)
    .filter((id): id is string => id !== null);

  const originalPostsMap = new Map<string, Post>();
  if (originalPostIds.length > 0) {
    const originalPostsList = await db
      .select()
      .from(posts)
      .where(
        and(
          inArray(posts.id, originalPostIds),
          isNull(posts.deletedAt),
          lte(posts.timestamp, new Date())
        )
      );
    const originalAuthors = [
      ...new Set(originalPostsList.map((post) => post.authorId)),
    ];
    const authorFlags = originalAuthors.length
      ? await db
          .select({ id: users.id, isTest: users.isTest })
          .from(users)
          .where(inArray(users.id, originalAuthors))
      : [];
    const testAuthors = new Set(
      authorFlags.filter((author) => author.isTest).map((author) => author.id)
    );
    for (const post of originalPostsList) {
      if (
        excludedUserIds.has(post.authorId) ||
        testAuthors.has(post.authorId) ||
        post.authorId.startsWith('test-') ||
        StaticDataRegistry.getActor(post.authorId)?.isTest
      )
        continue;
      originalPostsMap.set(post.id, post);
    }
  }

  // Merge original posts into posts with type casting
  const postsWithOriginal: PostWithOriginal[] = postsResult.map((p) => ({
    ...p,
    originalPost: p.originalPostId
      ? (originalPostsMap.get(p.originalPostId) ?? null)
      : null,
  }));

  // Filter out reposts where the original post is deleted
  const validPosts = postsWithOriginal.filter((post) => {
    // If it's a repost, check if original post exists and is not deleted
    if (post.originalPostId) {
      const hasOriginalPost = post.originalPost && !post.originalPost.deletedAt;
      const isQuote = post.content && post.content.length > 0;

      // For quote posts, keep them even if original is deleted (user has commentary)
      // For simple reposts, filter out if original is deleted
      if (isQuote) {
        return true; // Keep quote posts regardless
      }
      return hasOriginalPost; // Filter out simple reposts with deleted originals
    }
    return true;
  });

  const postAuthorIds = validPosts
    .map((p) => p.authorId)
    .filter((id): id is string => id !== undefined);
  const originalPostAuthorIds = validPosts
    .filter((p) => p.originalPostId && p.originalPost)
    .map((p) => p.originalPost!.authorId)
    .filter((id): id is string => id !== undefined);

  const authorIds = [...new Set([...postAuthorIds, ...originalPostAuthorIds])];

  const usersList =
    authorIds.length > 0
      ? await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(inArray(users.id, authorIds))
      : [];
  const userMap = new Map(usersList.map((u) => [u.id, u]));
  const actorMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [
        a.id,
        { id: a.id, name: a.name, profileImageUrl: a.profileImageUrl },
      ])
  );
  const orgMap = new Map(
    authorIds
      .map((id) => StaticDataRegistry.getOrganization(id))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => [o.id, { id: o.id, name: o.name, imageUrl: o.imageUrl }])
  );

  // PERFORMANCE OPTIMIZATION: Single consolidated CTE query for all post metadata
  // This replaces 7+ sequential queries with 1 optimized query
  // Fetches: reaction counts, comment counts, share counts, and comment previews with likes
  const postIds = validPosts.map((p) => p.id);
  const allPostIds = [
    ...new Set([
      ...postIds,
      ...originalPostIds.filter((id) => originalPostsMap.has(id)),
    ]),
  ];

  const {
    reactionMap,
    commentMap,
    shareMap,
    commentPreviewMap: rawCommentPreviewMap,
  } = await fetchPostMetadataConsolidated(allPostIds);

  // Process comment previews with engagement-based visibility logic
  // This determines which posts show comment previews based on engagement
  const commentPreviewMap = new Map<
    string,
    Array<{
      id: string;
      content: string;
      createdAt: string;
      userId: string;
      userName: string;
      userUsername: string | null;
      userAvatar: string | null;
      likeCount: number;
    }>
  >();

  // Process raw comment previews with engagement-based filtering
  for (const [postId, rawPreviews] of rawCommentPreviewMap) {
    const postCommentCount = commentMap.get(postId) ?? 0;
    const postLikeCount = reactionMap.get(postId) ?? 0;
    const topCommentLikes = rawPreviews[0]?.likeCount ?? 0;

    // Determine preview visibility with consistent bucketing per post
    // Uses character code sum to create deterministic bucket (0-99) for each post
    const engagementBucket =
      postId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 100;

    let showPreview = true;
    let previewLimit = 1;

    if (postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_HIGH) {
      previewLimit = 2;
      showPreview = true;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_MEDIUM ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_MEDIUM
    ) {
      previewLimit = 1;
      showPreview = true;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_LOW ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_LOW
    ) {
      previewLimit = 1;
      showPreview = engagementBucket < ENGAGEMENT_THRESHOLDS.VISIBILITY_HIGH;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_MINIMAL ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_MINIMAL
    ) {
      previewLimit = 1;
      showPreview = engagementBucket < ENGAGEMENT_THRESHOLDS.VISIBILITY_MEDIUM;
    } else if (
      postCommentCount >= ENGAGEMENT_THRESHOLDS.COMMENTS_VERY_LOW ||
      postLikeCount >= ENGAGEMENT_THRESHOLDS.LIKES_VERY_LOW
    ) {
      previewLimit = 1;
      showPreview =
        engagementBucket <
        (topCommentLikes > 0
          ? ENGAGEMENT_THRESHOLDS.VISIBILITY_LOW_WITH_LIKES
          : ENGAGEMENT_THRESHOLDS.VISIBILITY_LOW_NO_LIKES);
    } else {
      previewLimit = 1;
      showPreview =
        engagementBucket <
        (topCommentLikes >= ENGAGEMENT_THRESHOLDS.TOP_COMMENT_LIKES_BOOST
          ? ENGAGEMENT_THRESHOLDS.VISIBILITY_MINIMAL_WITH_LIKES
          : ENGAGEMENT_THRESHOLDS.VISIBILITY_MINIMAL_NO_LIKES);
    }

    if (!showPreview) continue;

    // Process previews for this post
    const previews: Array<{
      id: string;
      content: string;
      createdAt: string;
      userId: string;
      userName: string;
      userUsername: string | null;
      userAvatar: string | null;
      likeCount: number;
    }> = [];

    for (const comment of rawPreviews.slice(0, previewLimit)) {
      // Get actor info if not a regular user
      const actor = StaticDataRegistry.getActor(comment.authorId);
      const org = StaticDataRegistry.getOrganization(comment.authorId);

      let userName = comment.userName || comment.authorId;
      let userAvatar = comment.userAvatar;

      if (actor) {
        userName = actor.name;
        userAvatar = actor.profileImageUrl || null;
      } else if (org) {
        userName = org.name;
        userAvatar = org.imageUrl || null;
      }

      previews.push({
        id: comment.id,
        content: comment.content || '',
        createdAt: toFeedISOString(comment.createdAt),
        userId: comment.authorId,
        userName,
        userUsername: comment.userUsername,
        userAvatar,
        likeCount: comment.likeCount,
      });
    }

    if (previews.length > 0) {
      commentPreviewMap.set(postId, previews);
    }
  }

  // Format posts - simple transformation, no async queries needed!
  const formattedPosts = validPosts.map((post) => {
    const user = userMap.get(post.authorId!);
    const actor = actorMap.get(post.authorId!);
    const org = orgMap.get(post.authorId!);

    let authorName = post.authorId!;
    let authorUsername: string | null = null;
    let authorProfileImageUrl: string | null = null;

    if (actor) {
      authorName = actor.name;
      authorProfileImageUrl = actor.profileImageUrl!;
    } else if (org) {
      authorName = org.name;
      authorProfileImageUrl = org.imageUrl!;
    } else if (user) {
      authorName = user.displayName!;
      authorUsername = user.username!;
      authorProfileImageUrl = user.profileImageUrl;
    }

    const timestamp = toFeedISOString(post.timestamp);
    const createdAt = toFeedISOString(post.createdAt);

    // Build base post object
    const basePost = {
      id: post.id,
      type: post.type || undefined,
      content: post.content!,
      fullContent: post.fullContent || undefined,
      articleTitle: post.articleTitle || undefined,
      byline: post.byline || undefined,
      biasScore: post.biasScore !== undefined ? post.biasScore : undefined,
      sentiment: post.sentiment || undefined,
      slant: post.slant || undefined,
      category: post.category || undefined,
      author: post.authorId,
      authorId: post.authorId,
      authorName,
      authorUsername,
      authorProfileImageUrl,
      timestamp,
      createdAt,
      gameId: post.gameId || undefined,
      dayNumber: post.dayNumber || undefined,
      likeCount: reactionMap.get(post.id) ?? 0,
      commentCount: commentMap.get(post.id) ?? 0,
      shareCount: shareMap.get(post.id) ?? 0,
      isLiked: false,
      isShared: false,
      // Comment previews for inline display on feed
      commentPreviews: commentPreviewMap.get(post.id) ?? undefined,
    };

    // Check if this is a repost/quote by presence of originalPostId
    if (post.originalPostId) {
      const isQuote = post.content && post.content.length > 0;
      const originalPost = post.originalPost;

      // If original post exists and is not deleted
      if (originalPost && !originalPost.deletedAt) {
        // Get original post author info
        const originalUser = userMap.get(originalPost.authorId);
        const originalActor = actorMap.get(originalPost.authorId);
        const originalOrg = orgMap.get(originalPost.authorId);

        let originalAuthorName = originalPost.authorId;
        let originalAuthorUsername: string | null = null;
        let originalAuthorProfileImageUrl: string | null = null;

        if (originalActor) {
          originalAuthorName = originalActor.name;
          originalAuthorProfileImageUrl = originalActor.profileImageUrl!;
        } else if (originalOrg) {
          originalAuthorName = originalOrg.name;
          originalAuthorProfileImageUrl = originalOrg.imageUrl!;
        } else if (originalUser) {
          originalAuthorName = originalUser.displayName!;
          originalAuthorUsername = originalUser.username!;
          originalAuthorProfileImageUrl = originalUser.profileImageUrl;
        }

        // For simple reposts (not quotes), use the original post's interaction counts and previews
        // For quote posts, keep the quote post's interaction counts and previews
        const interactionCounts = !isQuote
          ? {
              likeCount: reactionMap.get(originalPost.id) ?? 0,
              commentCount: commentMap.get(originalPost.id) ?? 0,
              shareCount: shareMap.get(originalPost.id) ?? 0,
              // Use original post's comment previews for simple reposts
              commentPreviews:
                commentPreviewMap.get(originalPost.id) ?? undefined,
            }
          : {
              likeCount: basePost.likeCount,
              commentCount: basePost.commentCount,
              shareCount: basePost.shareCount,
            };

        return {
          ...basePost,
          ...interactionCounts,
          isRepost: true,
          isQuote,
          quoteComment: isQuote ? post.content : null,
          originalPostId: originalPost.id,
          originalPost: {
            id: originalPost.id,
            content: originalPost.content,
            authorId: originalPost.authorId,
            authorName: originalAuthorName,
            authorUsername: originalAuthorUsername,
            authorProfileImageUrl: originalAuthorProfileImageUrl,
            timestamp: toFeedISOString(originalPost.timestamp),
          },
        };
      }

      // If original post is deleted but this is a quote post, return with null originalPost
      if (isQuote) {
        return {
          ...basePost,
          isRepost: true,
          isQuote: true,
          quoteComment: post.content,
          originalPostId: post.originalPostId,
          originalPost: null,
        };
      }
    }

    return basePost;
  });

  // NOTE: Author diversity is NOT applied at the API layer because it would break
  // cursor-based pagination. Post-query reordering cannot be reconciled with
  // timestamp-based cursors without causing duplicates across pages.
  // Feed diversity is instead handled at generation time via:
  // - Stratified action deck (quote/reply ratio with no-consecutive constraint)
  // - Timestamp staggering (posts spread across 5-minute windows)
  // - Action diversity tracker (prevents consecutive same action types)

  logger.info(
    'Formatted posts',
    {
      originalCount: postsResult.length,
      formattedCount: formattedPosts.length,
      filteredOut: postsResult.length - formattedPosts.length,
    },
    'GET /api/posts'
  );

  // The raw window tail avoids terminating pagination when every fetched row is
  // hidden and keeps keyset ordering independent of response projection.
  const lastPost = fetchedWindow[fetchedWindow.length - 1];
  const nextCursor = lastPost
    ? encodePostCursor(toFeedISOString(lastPost.timestamp), lastPost.id)
    : null;

  return {
    success: true,
    posts: formattedPosts,
    limit,
    cursor: nextCursor,
    hasMore: fetchedWindow.length === limit,
  };
}
