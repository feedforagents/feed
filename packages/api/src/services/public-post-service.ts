import {
  and,
  comments,
  count,
  db,
  eq,
  isNull,
  lte,
  posts,
  reactions,
  shares,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, toISO } from '@feed/shared';
import { BusinessLogicError, NotFoundError } from '../errors';
import { canViewerReadAuthor } from './public-read-visibility';

/** Canonical public post read shared by REST and MCP. Viewer identity is supplied
 * only by the authenticated adapter, never by request query parameters. */
export async function getPublicPost(postId: string, viewerId?: string) {
  const now = new Date();

  // Get post from database
  const [post] = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.id, postId),
        lte(posts.timestamp, now) // No future posts
      )
    )
    .limit(1);

  // Get counts and user interactions
  const userId = viewerId;

  // Unknown (or not-yet-published) IDs are simply not found. This route
  // never creates posts on read.
  if (!post) {
    throw new NotFoundError('Post', postId);
  }

  const [authorUser] = await db
    .select({
      displayName: users.displayName,
      username: users.username,
      profileImageUrl: users.profileImageUrl,
      isTest: users.isTest,
    })
    .from(users)
    .where(eq(users.id, post.authorId))
    .limit(1);

  if (
    !(await canViewerReadAuthor(
      viewerId,
      post.authorId,
      authorUser?.isTest ?? false
    ))
  ) {
    throw new NotFoundError('Post', postId);
  }

  // Check if post is deleted
  if (post.deletedAt) {
    throw new BusinessLogicError('This post has been deleted', 'POST_DELETED');
  }

  // Get counts
  const [[likeCountResult], [commentCountResult], [shareCountResult]] =
    await Promise.all([
      db
        .select({ count: count() })
        .from(reactions)
        .where(and(eq(reactions.postId, postId), eq(reactions.type, 'like'))),
      db
        .select({ count: count() })
        .from(comments)
        .where(and(eq(comments.postId, postId), isNull(comments.deletedAt))),
      db
        .select({ count: count() })
        .from(shares)
        .where(eq(shares.postId, postId)),
    ]);

  const likeCount = Number(likeCountResult?.count ?? 0);
  const commentCount = Number(commentCountResult?.count ?? 0);
  const shareCount = Number(shareCountResult?.count ?? 0);

  // Get user interactions
  let isLiked = false;
  let isShared = false;

  if (userId) {
    const [[likedResult], [sharedResult]] = await Promise.all([
      db
        .select({ id: reactions.id })
        .from(reactions)
        .where(
          and(
            eq(reactions.postId, postId),
            eq(reactions.userId, userId),
            eq(reactions.type, 'like')
          )
        )
        .limit(1),
      db
        .select({ id: shares.id })
        .from(shares)
        .where(and(eq(shares.postId, postId), eq(shares.userId, userId)))
        .limit(1),
    ]);
    isLiked = !!likedResult;
    isShared = !!sharedResult;
  }

  let authorName = post.authorId;
  let authorUsername: string | null = null;
  let authorProfileImageUrl: string | null = null;

  const actor = StaticDataRegistry.getActor(post.authorId);

  if (actor) {
    authorName = actor.name;
    // Use database profileImageUrl or construct path from actor ID
    authorProfileImageUrl =
      actor.profileImageUrl || `/images/actors/${actor.id}.jpg`;
  } else {
    // Check if it's an organization (for articles)
    const org = StaticDataRegistry.getOrganization(post.authorId);

    if (org) {
      authorName = org.name;
      // Use database imageUrl or construct path from organization ID
      authorProfileImageUrl =
        org.imageUrl || `/images/organizations/${org.id}.jpg`;
    } else {
      if (authorUser) {
        authorName =
          authorUser.displayName || authorUser.username || post.authorId;
        authorUsername = authorUser.username || null;
        authorProfileImageUrl = authorUser.profileImageUrl || null;
      }
    }
  }

  // Build repost metadata from originalPostId (clean, no regex parsing)
  let repostMetadata: {
    isRepost?: boolean;
    isQuote?: string | boolean;
    quoteComment?: string | null;
    originalPostId?: string;
    originalPost?: {
      id: string;
      content: string;
      authorId: string;
      authorName: string;
      authorUsername: string;
      authorProfileImageUrl: string | null;
      timestamp: string;
    };
  } = {};

  if (post.originalPostId) {
    const [originalPost] = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, post.originalPostId),
          isNull(posts.deletedAt),
          lte(posts.timestamp, now)
        )
      )
      .limit(1);

    if (originalPost) {
      // Resolve the original author once for visibility and the public DTO.
      const [originalUser] = await db
        .select({
          id: users.id,
          isTest: users.isTest,
          username: users.username,
          displayName: users.displayName,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(eq(users.id, originalPost.authorId))
        .limit(1);

      if (
        await canViewerReadAuthor(
          viewerId,
          originalPost.authorId,
          originalUser?.isTest ?? false
        )
      ) {
        const isQuote = post.content && post.content.length > 0;
        const originalActor = !originalUser
          ? StaticDataRegistry.getActor(originalPost.authorId)
          : null;

        const originalOrg =
          !originalUser && !originalActor
            ? StaticDataRegistry.getOrganization(originalPost.authorId)
            : null;

        const originalAuthor = originalUser || originalActor || originalOrg;

        if (originalAuthor) {
          const authorName =
            originalUser?.displayName ??
            originalActor?.name ??
            originalOrg?.name ??
            originalPost.authorId;
          const authorUsername =
            originalUser?.username ??
            originalActor?.username ??
            originalOrg?.id ??
            originalPost.authorId;
          const authorProfileImageUrl =
            originalUser?.profileImageUrl ??
            originalActor?.profileImageUrl ??
            originalOrg?.imageUrl ??
            null;
          repostMetadata = {
            isRepost: true,
            isQuote,
            quoteComment: isQuote ? post.content : null,
            originalPostId: originalPost.id,
            originalPost: {
              id: originalPost.id,
              content: originalPost.content,
              authorId: originalPost.authorId,
              authorName,
              authorUsername,
              authorProfileImageUrl,
              timestamp:
                originalPost.timestamp?.toISOString?.() ||
                new Date().toISOString(),
            },
          };
        }
      }
    }
  }

  logger.info(
    'Post fetched successfully',
    { postId, source: 'database' },
    'GET /api/posts/[id]'
  );

  return {
    id: post.id,
    type: post.type || 'post',
    content: post.content,
    fullContent: post.fullContent || null,
    articleTitle: post.articleTitle || null,
    byline: post.byline || null,
    biasScore: post.biasScore !== undefined ? post.biasScore : null,
    sentiment: post.sentiment || null,
    slant: post.slant || null,
    category: post.category || null,
    imageUrl: post.imageUrl || null,
    authorId: post.authorId,
    authorName: authorName,
    authorUsername: authorUsername,
    authorProfileImageUrl: authorProfileImageUrl,
    authorAvatar: authorProfileImageUrl || undefined,
    isActorPost: true, // Posts are from game actors
    timestamp: post.timestamp ? toISO(post.timestamp) : toISO(post.createdAt),
    createdAt: toISO(post.createdAt),
    likeCount,
    commentCount,
    shareCount,
    isLiked,
    isShared,
    source: 'database',
    ...repostMetadata, // Add repost metadata if applicable
  };
}
