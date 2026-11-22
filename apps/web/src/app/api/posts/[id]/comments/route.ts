/**
 * API Route: /api/posts/[id]/comments
 * Methods: GET (get comments), POST (add comment)
 *
 * @openapi
 * /api/posts/{id}/comments:
 *   get:
 *     tags:
 *       - Comments
 *     summary: Get comments for a post
 *     description: Returns threaded comments for a post, ordered chronologically with reply structure.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Comments list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comments:
 *                   type: array
 *                   items:
 *                     type: object
 *       404:
 *         description: Post not found
 *   post:
 *     tags:
 *       - Comments
 *     summary: Add comment to post
 *     description: Creates a new comment on a post. Supports mentions and replies. Creates notifications.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 minLength: 1
 *                 description: Comment content
 *               parentCommentId:
 *                 type: string
 *                 nullable: true
 *                 description: Parent comment ID for replies
 *     responses:
 *       200:
 *         description: Comment created successfully
 *       400:
 *         description: Invalid content or rate limited
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found
 */

import {
  addPrivateReadHeaders,
  addPublicReadHeaders,
  authenticate,
  BusinessLogicError,
  checkRateLimitAndDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  ensureUserForAuth,
  getCanonicalUserId,
  NotFoundError,
  notifyCommentOnPost,
  notifyMention,
  notifyReplyToComment,
  publicRateLimit,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  asc,
  comments,
  count,
  db,
  eq,
  hasBlocked,
  inArray,
  isNull,
  posts,
  reactions,
  users,
} from '@feed/db';
import {
  CreateCommentSchema,
  generateSnowflakeId,
  logger,
  PostIdParamSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { loadViewerExcludedAuthorIds } from '@/app/api/feed/_lib/viewer-moderation';

/**
 * Build threaded comment structure recursively
 */
type CommentTreeItem = {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  userName: string;
  userUsername: string | null;
  userAvatar: string | null;
  parentCommentId: string | null;
  parentCommentAuthorName?: string;
  likeCount: number;
  isLiked: boolean;
  replies: CommentTreeItem[];
};

interface CommentWithUser {
  id: string;
  content: string;
  authorId: string;
  parentCommentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  user: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    isActor: boolean;
  } | null;
  likeCount: number;
  isLiked: boolean;
}

function buildCommentTree(commentsData: CommentWithUser[]): CommentTreeItem[] {
  const byId = new Map(commentsData.map((c) => [c.id, c]));
  const childrenByParent = new Map<string | null, CommentWithUser[]>();
  for (const comment of commentsData) {
    const siblings = childrenByParent.get(comment.parentCommentId);
    if (siblings) siblings.push(comment);
    else childrenByParent.set(comment.parentCommentId, [comment]);
  }

  const parentAuthorName = (
    parentCommentId: string | null
  ): string | undefined => {
    if (!parentCommentId) return undefined;
    const parent = byId.get(parentCommentId);
    if (!parent?.user) return undefined;
    return parent.user.displayName || parent.user.username || 'Anonymous';
  };

  // Comments whose parent is not visible (e.g. hidden by moderation) are
  // unreachable from the root and therefore omitted with their parent.
  const build = (parentId: string | null): CommentTreeItem[] =>
    (childrenByParent.get(parentId) ?? []).map((comment) => ({
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      userId: comment.user?.id || comment.authorId,
      userName:
        comment.user?.displayName || comment.user?.username || 'Anonymous',
      userUsername: comment.user?.username || null,
      userAvatar: comment.user?.profileImageUrl || null,
      parentCommentId: comment.parentCommentId,
      parentCommentAuthorName: parentAuthorName(comment.parentCommentId),
      likeCount: comment.likeCount,
      isLiked: comment.isLiked,
      replies: build(comment.id),
    }));

  return build(null);
}

/**
 * GET /api/posts/[id]/comments
 * Get threaded comments for a post
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { error, user, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { id: postId } = await context.params;

    // Validate post ID
    if (!postId) {
      throw new BusinessLogicError('Post ID is required', 'POST_ID_REQUIRED');
    }

    const canonicalUserId = user ? getCanonicalUserId(user) : undefined;

    // Check if post exists and is not in the future
    const now = new Date();
    const [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!post) {
      throw new NotFoundError('Post', postId);
    }

    if (post.deletedAt) {
      throw new NotFoundError('Post (deleted)', postId);
    }

    // Don't allow access to future posts
    if (post.timestamp > now) {
      throw new NotFoundError('Post', postId);
    }

    // Get all visible comments for the post (including nested replies).
    // Soft-deleted (moderated) comments must never be returned.
    let commentsResult = await db
      .select()
      .from(comments)
      .where(and(eq(comments.postId, postId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt));

    // Apply the viewer's moderation policy, as the post feeds, favorites
    // feed, notifications and user search do: comments by authors the
    // viewer blocked or muted — or who blocked the viewer — are not
    // returned. Their replies go with them, matching the tree rule for
    // comments whose parent is not visible. Anonymous reads have no
    // moderation set and stay unfiltered. The exclusion set comes from the
    // shared loadViewerExcludedAuthorIds definition, which the post detail
    // count uses as well, so both numbers agree for the same viewer.
    if (canonicalUserId && commentsResult.length > 0) {
      const excludedAuthorIds =
        await loadViewerExcludedAuthorIds(canonicalUserId);
      if (excludedAuthorIds.size > 0) {
        commentsResult = commentsResult.filter(
          (comment) => !excludedAuthorIds.has(comment.authorId)
        );
      }
    }

    // Get author IDs
    const authorIds = [...new Set(commentsResult.map((c) => c.authorId))];

    // Get user info for all authors
    const usersResult =
      authorIds.length > 0
        ? await db
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
              isActor: users.isActor,
            })
            .from(users)
            .where(inArray(users.id, authorIds))
        : [];

    const userMap = new Map(usersResult.map((u) => [u.id, u]));

    // Get like counts for all comments
    const commentIds = commentsResult.map((c) => c.id);
    const likeCounts =
      commentIds.length > 0
        ? await db
            .select({
              commentId: reactions.commentId,
              count: count(),
            })
            .from(reactions)
            .where(
              and(
                inArray(reactions.commentId, commentIds),
                eq(reactions.type, 'like')
              )
            )
            .groupBy(reactions.commentId)
        : [];

    const likeCountMap = new Map(
      likeCounts.map((l) => [l.commentId, Number(l.count)])
    );

    // Get user's likes if authenticated
    const userLikes = new Set<string>();
    if (canonicalUserId && commentIds.length > 0) {
      const userLikesResult = await db
        .select({ commentId: reactions.commentId })
        .from(reactions)
        .where(
          and(
            inArray(reactions.commentId, commentIds),
            eq(reactions.userId, canonicalUserId),
            eq(reactions.type, 'like')
          )
        );
      userLikesResult.forEach((l) => {
        if (l.commentId) userLikes.add(l.commentId);
      });
    }

    // Map comments with user info and like counts
    const commentsWithData: CommentWithUser[] = commentsResult.map(
      (comment) => ({
        id: comment.id,
        content: comment.content,
        authorId: comment.authorId,
        parentCommentId: comment.parentCommentId,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        user: userMap.get(comment.authorId) || null,
        likeCount: likeCountMap.get(comment.id) ?? 0,
        isLiked: userLikes.has(comment.id),
      })
    );

    // Build threaded structure
    const threadedComments = buildCommentTree(commentsWithData);

    // Total is the number of comments this response actually returns.
    // Replies whose parent is not visible (e.g. soft-deleted by
    // moderation) are omitted from the tree with their parent, so the
    // raw row count would promise comments that are not in the list.
    const countTreeNodes = (items: CommentTreeItem[]): number =>
      items.reduce((sum, item) => sum + 1 + countTreeNodes(item.replies), 0);
    const totalComments = countTreeNodes(threadedComments);

    logger.info(
      'Comments fetched successfully',
      { postId, total: totalComments },
      'GET /api/posts/[id]/comments'
    );

    const res = successResponse({
      data: {
        comments: threadedComments,
        total: totalComments,
      },
    });
    if (canonicalUserId) {
      // Includes the viewer's isLiked: never shared-cacheable.
      if (rateLimitInfo) addPrivateReadHeaders(res, rateLimitInfo);
      else res.headers.set('Cache-Control', 'private, no-store');
    } else if (rateLimitInfo) {
      addPublicReadHeaders(res, rateLimitInfo);
    }
    return res;
  }
);

/**
 * POST /api/posts/[id]/comments
 * Add a comment to a post
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    // Parse and validate request body
    const body = await request.json();
    const validatedData = CreateCommentSchema.parse(body);
    const { content, parentCommentId } = validatedData;

    if (content.length > 5000) {
      throw new BusinessLogicError(
        'Comment is too long (max 5000 characters)',
        'COMMENT_TOO_LONG'
      );
    }

    // Apply rate limiting and duplicate detection
    const rateLimitError = await checkRateLimitAndDuplicates(
      user.userId,
      content,
      RATE_LIMIT_CONFIGS.CREATE_COMMENT,
      DUPLICATE_DETECTION_CONFIGS.COMMENT
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const displayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    const { user: dbUser } = await ensureUserForAuth(user, { displayName });
    const canonicalUserId = dbUser.id;

    // Check if post exists first
    const [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    // Comments may only be added to existing, published posts. Unknown IDs
    // are never turned into placeholder posts.
    if (!post || post.timestamp > new Date()) {
      throw new NotFoundError('Post', postId);
    } else if (post.deletedAt) {
      // Post exists but is deleted - cannot comment
      throw new BusinessLogicError(
        'Cannot comment on deleted post',
        'POST_DELETED'
      );
    }

    // If parentCommentId provided, validate it exists and belongs to this post
    if (parentCommentId) {
      const [parentComment] = await db
        .select({ id: comments.id, postId: comments.postId })
        .from(comments)
        .where(
          and(eq(comments.id, parentCommentId), isNull(comments.deletedAt))
        )
        .limit(1);

      if (!parentComment) {
        throw new NotFoundError('Parent comment', parentCommentId);
      }

      if (parentComment.postId !== postId) {
        throw new BusinessLogicError(
          'Parent comment does not belong to this post',
          'PARENT_COMMENT_MISMATCH'
        );
      }
    }

    // Get the post to find the authorId for notifications
    const [postRecord] = await db
      .select({ id: posts.id, authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    // Check if either user has blocked the other
    if (postRecord) {
      const [isBlocked, hasBlockedMe] = await Promise.all([
        hasBlocked(postRecord.authorId, canonicalUserId),
        hasBlocked(canonicalUserId, postRecord.authorId),
      ]);

      if (isBlocked || hasBlockedMe) {
        throw new BusinessLogicError(
          'Cannot comment on this post',
          'BLOCKED_USER'
        );
      }
    }

    // Create comment
    const now = new Date();
    const commentId = await generateSnowflakeId();

    const [newComment] = await db
      .insert(comments)
      .values({
        id: commentId,
        content: content.trim(),
        postId,
        authorId: canonicalUserId,
        parentCommentId: parentCommentId || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!newComment) {
      throw new BusinessLogicError(
        'Failed to create comment',
        'COMMENT_CREATION_FAILED'
      );
    }

    // Get user info for response
    const [commentUser] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
        isActor: users.isActor,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // Create notifications
    if (parentCommentId) {
      // Reply to comment - notify the parent comment author
      const [parentComment] = await db
        .select({ authorId: comments.authorId })
        .from(comments)
        .where(eq(comments.id, parentCommentId))
        .limit(1);

      if (parentComment && parentComment.authorId !== canonicalUserId) {
        await notifyReplyToComment(
          parentComment.authorId,
          canonicalUserId,
          postId,
          parentCommentId,
          newComment.id
        );
      }
    } else {
      // Comment on post - notify the post author only if they're a User (not an Actor)
      if (
        postRecord &&
        postRecord.authorId &&
        postRecord.authorId !== canonicalUserId
      ) {
        // Check if the authorId references a User (not an Actor)
        const [postAuthorUser] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, postRecord.authorId))
          .limit(1);

        if (postAuthorUser) {
          await notifyCommentOnPost(
            postRecord.authorId,
            canonicalUserId,
            postId,
            newComment.id
          );
        }
      }
    }

    const mentions = content.match(/@(\w+)/g) || [];
    const usernames = [...new Set(mentions.map((m) => m.substring(1)))];

    const mentionedUsers =
      usernames.length > 0
        ? await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.username, usernames))
        : [];

    await Promise.all(
      mentionedUsers.map((mentionedUser) =>
        notifyMention(mentionedUser.id, canonicalUserId, postId, newComment.id)
      )
    );

    logger.info(
      'Sent mention notifications from comment',
      {
        postId,
        commentId: newComment.id,
        mentionCount: mentionedUsers.length,
        mentionedUsernames: mentionedUsers.map((u) => u.username),
      },
      'POST /api/posts/[id]/comments'
    );

    logger.info(
      'Comment created successfully',
      {
        postId,
        userId: canonicalUserId,
        commentId: newComment.id,
        parentCommentId,
      },
      'POST /api/posts/[id]/comments'
    );

    return successResponse(
      {
        id: newComment.id,
        content: newComment.content,
        postId: newComment.postId,
        authorId: newComment.authorId,
        parentCommentId: newComment.parentCommentId,
        createdAt: newComment.createdAt,
        updatedAt: newComment.updatedAt,
        author: commentUser,
        likeCount: 0,
        replyCount: 0,
      },
      201
    );
  }
);
