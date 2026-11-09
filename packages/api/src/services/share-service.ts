/**
 * Share / repost a post.
 *
 * Canonical implementation shared by the HTTP route and the MCP tool handlers
 * so every transport applies the same rules: the post must exist, be
 * published and not deleted; a pure repost resolves to its original; blocked
 * users cannot share; a post is shared once per user; the share creates a
 * repost post (carrying the optional quote comment) in the sharer's feed; and
 * the original author is notified.
 */

import {
  and,
  count,
  db,
  eq,
  hasBlocked,
  isNull,
  posts,
  shares,
  sql,
  type Transaction,
  users,
} from '@feed/db';
import { NPCInteractionTracker, StaticDataRegistry } from '@feed/engine';
import {
  generateSnowflakeId,
  isPureRepost,
  logger,
  SharePostSchema,
  toISO,
} from '@feed/shared';
import { cachedDb } from '../cache';
import { BusinessLogicError, NotFoundError } from '../errors';
import { broadcastToChannel } from '../sse/event-broadcaster';
import type { JsonValue } from '../types';
import { notifyShare } from './notification-service';

export interface SharePostSharer {
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

export interface SharedRepostPost {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorProfileImageUrl: string | null;
  timestamp: string;
  isRepost: true;
  isQuote: boolean;
  originalPostId: string;
  originalPost: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername: string;
    authorProfileImageUrl: string | null | undefined;
    timestamp: string;
  };
  quoteComment: string | null;
}

export interface SharePostOutcome {
  shareId: string;
  /** The post the share points at (the original when a pure repost was shared). */
  shareTargetPostId: string;
  /** Author of the shared post. */
  postAuthorId: string | null;
  /** Number of shares the target post has after this one. */
  shareCount: number;
  repostId: string;
  repostPost: SharedRepostPost | null;
}

/** Optional audit write, awaited in the mutation transaction. Database work only;
 * callers must never perform network or inference calls while locks are held. */
export type ShareMutationObserver = (transaction: Transaction) => Promise<void>;

const LOG_CONTEXT = 'sharePost';

/**
 * Share `postId` as `userId`, optionally as a quote with `comment`.
 *
 * `sharer` is the sharer's profile when the caller already has it; otherwise
 * it is read from the database.
 */
export async function sharePost(
  userId: string,
  postId: string,
  comment?: string,
  sharer?: SharePostSharer,
  observeMutation?: ShareMutationObserver
): Promise<SharePostOutcome> {
  const quoteComment = SharePostSchema.parse({ comment }).comment || undefined;
  const now = new Date();
  const [post] = await db
    .select({
      id: posts.id,
      content: posts.content,
      deletedAt: posts.deletedAt,
      authorId: posts.authorId,
      timestamp: posts.timestamp,
      originalPostId: posts.originalPostId,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  // Unknown or not-yet-published posts cannot be shared (and are never
  // created from the ID).
  if (!post || post.timestamp > now) {
    throw new NotFoundError('Post', postId);
  }
  if (post.deletedAt) {
    throw new BusinessLogicError('Cannot share deleted post', 'POST_DELETED');
  }

  let shareTargetPostId = postId;
  let shareTargetPost = post;

  if (isPureRepost(post)) {
    shareTargetPostId = post.originalPostId;
    const [resolvedPost] = await db
      .select({
        id: posts.id,
        content: posts.content,
        deletedAt: posts.deletedAt,
        authorId: posts.authorId,
        timestamp: posts.timestamp,
        originalPostId: posts.originalPostId,
      })
      .from(posts)
      .where(eq(posts.id, shareTargetPostId))
      .limit(1);

    if (!resolvedPost) {
      throw new NotFoundError('Post', shareTargetPostId);
    }

    shareTargetPost = resolvedPost;
  }

  if (shareTargetPost.timestamp > now) {
    throw new NotFoundError('Post', shareTargetPostId);
  }

  const [isBlocked, hasBlockedMe] = await Promise.all([
    hasBlocked(shareTargetPost.authorId, userId),
    hasBlocked(userId, shareTargetPost.authorId),
  ]);

  if (isBlocked || hasBlockedMe) {
    throw new BusinessLogicError('Cannot share this post', 'BLOCKED_USER');
  }

  if (shareTargetPost.deletedAt) {
    throw new BusinessLogicError('Cannot share deleted post', 'POST_DELETED');
  }

  const [existingShare] = await db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.userId, userId), eq(shares.postId, shareTargetPostId)))
    .limit(1);

  if (existingShare) {
    throw new BusinessLogicError('Post already shared', 'ALREADY_SHARED');
  }

  // Backfill safety: legacy shares may still point at repost IDs
  if (isPureRepost(post) && shareTargetPostId !== postId) {
    const [existingRepostShare] = await db
      .select({ id: shares.id })
      .from(shares)
      .where(and(eq(shares.userId, userId), eq(shares.postId, postId)))
      .limit(1);

    if (existingRepostShare) {
      throw new BusinessLogicError('Post already shared', 'ALREADY_SHARED');
    }
  }

  let sharerProfile = sharer;
  if (!sharerProfile) {
    const [sharerRow] = await db
      .select({
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!sharerRow) {
      throw new NotFoundError('User', userId);
    }
    sharerProfile = sharerRow;
  }

  const shareId = await generateSnowflakeId();
  const repostId = await generateSnowflakeId();

  const [originalPost] = await db
    .select({
      content: posts.content,
      authorId: posts.authorId,
      timestamp: posts.timestamp,
    })
    .from(posts)
    .where(eq(posts.id, shareTargetPostId))
    .limit(1);

  if (originalPost && originalPost.timestamp > now) {
    throw new NotFoundError('Post', shareTargetPostId);
  }

  // The share and the repost/quote post are written together: a failure after
  // the share row is inserted must not leave a share without its post (a retry
  // would then fail with ALREADY_SHARED).
  const createdRepost = await db.transaction(async (tx) => {
    await tx.insert(shares).values({
      id: shareId,
      userId,
      postId: shareTargetPostId,
    });

    if (!originalPost) {
      throw new NotFoundError('Post', shareTargetPostId);
    }

    const [created] = await tx
      .insert(posts)
      .values({
        id: repostId,
        content: quoteComment || '',
        authorId: userId,
        timestamp: new Date(),
        originalPostId: shareTargetPostId,
      })
      .returning();

    if (!created) {
      throw new BusinessLogicError('Failed to create repost', 'CREATE_FAILED');
    }

    if (observeMutation) await observeMutation(tx);
    return created;
  });

  // NPC interaction tracking is ancillary: it must not fail a share that has
  // already been committed.
  try {
    await NPCInteractionTracker.trackShare(userId, shareTargetPostId);
  } catch (error) {
    logger.warn(
      'Failed to track share interaction',
      {
        userId,
        postId: shareTargetPostId,
        error: error instanceof Error ? error.message : String(error),
      },
      LOG_CONTEXT
    );
  }

  let repostPost: SharedRepostPost | null = null;

  if (originalPost && createdRepost) {
    const [originalUser] = await db
      .select({
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, originalPost.authorId))
      .limit(1);

    const originalActor = StaticDataRegistry.getActor(originalPost.authorId);
    const originalOrg = StaticDataRegistry.getOrganization(
      originalPost.authorId
    );

    const originalAuthorName =
      originalUser?.displayName ||
      originalUser?.username ||
      originalActor?.name ||
      originalOrg?.name ||
      originalPost.authorId;
    const originalAuthorUsername =
      originalUser?.username || originalPost.authorId;
    const originalAuthorProfileImageUrl =
      originalUser?.profileImageUrl ||
      originalActor?.profileImageUrl ||
      originalOrg?.imageUrl;

    repostPost = {
      id: createdRepost.id,
      content: createdRepost.content,
      authorId: createdRepost.authorId,
      authorName:
        sharerProfile.username ||
        sharerProfile.displayName ||
        `user_${userId.slice(0, 8)}`,
      authorUsername: sharerProfile.username,
      authorDisplayName: sharerProfile.displayName,
      authorProfileImageUrl: sharerProfile.profileImageUrl,
      timestamp: toISO(createdRepost.timestamp),
      isRepost: true,
      isQuote: !!quoteComment,
      originalPostId: shareTargetPostId,
      originalPost: {
        id: shareTargetPostId,
        content: originalPost.content,
        authorId: originalPost.authorId,
        authorName: originalAuthorName,
        authorUsername: originalAuthorUsername,
        authorProfileImageUrl: originalAuthorProfileImageUrl,
        timestamp: toISO(originalPost.timestamp),
      },
      quoteComment: quoteComment || null,
    };

    await cachedDb.invalidatePostsCache();
    await cachedDb.invalidateActorPostsCache(userId);
    logger.info(
      'Invalidated post caches after repost',
      { repostId },
      LOG_CONTEXT
    );

    broadcastToChannel('feed', {
      type: 'new_post',
      post: repostPost as unknown as JsonValue,
    });
    logger.info(
      'Broadcast repost to feed channel',
      { repostId, postId: shareTargetPostId },
      LOG_CONTEXT
    );
  }

  const postAuthorId = shareTargetPost.authorId ?? null;

  if (postAuthorId && postAuthorId !== userId) {
    const [postAuthorUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, postAuthorId))
      .limit(1);

    if (postAuthorUser) {
      // The share and quote have committed. A notification outage must not
      // tell the caller that the share failed and invite an unsuccessful retry.
      try {
        await notifyShare(postAuthorId, userId, shareTargetPostId);
      } catch (error) {
        logger.warn(
          'Failed to notify author of committed share',
          {
            postId: shareTargetPostId,
            userId,
            error: error instanceof Error ? error.message : String(error),
          },
          LOG_CONTEXT
        );
      }
    }
  }

  const [shareCountResult] = await db
    .select({ count: count() })
    .from(shares)
    .where(eq(shares.postId, shareTargetPostId));
  const shareCount = Number(shareCountResult?.count ?? 0);

  logger.info(
    'Post shared successfully',
    { postId: shareTargetPostId, userId, shareCount },
    LOG_CONTEXT
  );

  return {
    shareId,
    shareTargetPostId,
    postAuthorId,
    shareCount,
    repostId,
    repostPost,
  };
}

export interface UnsharePostOutcome {
  shareTargetPostId: string;
  shareCount: number;
}

/** Remove only this account's share and associated repost, together. */
export async function unsharePost(
  userId: string,
  postId: string,
  observeMutation?: ShareMutationObserver,
  options: { pureOnly?: boolean } = {}
): Promise<UnsharePostOutcome> {
  const shareTargetPostId = await db.transaction(async (tx) => {
    let targetPostId = postId;
    let [share] = await tx
      .select({ id: shares.id })
      .from(shares)
      .where(and(eq(shares.userId, userId), eq(shares.postId, postId)))
      .limit(1)
      .for('update');

    if (!share) {
      const [post] = await tx
        .select({
          content: posts.content,
          originalPostId: posts.originalPostId,
        })
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);
      if (post && isPureRepost(post)) {
        targetPostId = post.originalPostId;
        const [redirectedShare] = await tx
          .select({ id: shares.id })
          .from(shares)
          .where(
            and(eq(shares.userId, userId), eq(shares.postId, targetPostId))
          )
          .limit(1)
          .for('update');
        share = redirectedShare;
      }
    }
    if (!share) throw new NotFoundError('Share', `${postId}-${userId}`);

    const [repost] = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, userId),
          eq(posts.originalPostId, targetPostId),
          isNull(posts.deletedAt),
          ...(options.pureOnly ? [sql`btrim(${posts.content}) = ''`] : [])
        )
      )
      .limit(1);
    if (!repost && options.pureOnly) {
      const [quote] = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            eq(posts.authorId, userId),
            eq(posts.originalPostId, targetPostId),
            isNull(posts.deletedAt)
          )
        )
        .limit(1);
      if (quote)
        throw new BusinessLogicError(
          'This is a quote post; delete the quote explicitly instead',
          'NOT_A_REPOST'
        );
    }
    if (repost) await tx.delete(posts).where(eq(posts.id, repost.id));
    await tx.delete(shares).where(eq(shares.id, share.id));
    if (observeMutation) await observeMutation(tx);
    return targetPostId;
  });
  const [countResult] = await db
    .select({ count: count() })
    .from(shares)
    .where(eq(shares.postId, shareTargetPostId));
  await cachedDb.invalidatePostsCache();
  await cachedDb.invalidateActorPostsCache(userId);
  return { shareTargetPostId, shareCount: Number(countResult?.count ?? 0) };
}
