import { dbWrite, eq, inArray, posts, type Transaction, users } from '@feed/db';
import {
  type GeneratedTag,
  generateTagsFromPost,
  handlePlayerMention,
  StaticDataRegistry,
  storeTagsForPost,
} from '@feed/engine';
import {
  CreatePostSchema,
  generateSnowflakeId,
  logger,
  toISO,
} from '@feed/shared';
import { cachedDb, invalidateCache } from '../cache';
import { ForbiddenError, NotFoundError } from '../errors';
import {
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
} from '../rate-limiting/user-rate-limiter';
import { broadcastToChannel } from '../sse/event-broadcaster';
import {
  checkDuplicate,
  DUPLICATE_DETECTION_CONFIGS,
} from '../utils/duplicate-detector';
import { checkProgress } from './achievement-service';
import { notifyMention } from './notification-service';

export class FeedPostCreationError extends Error {
  constructor(
    readonly kind: 'rate_limit' | 'duplicate' | 'persistence',
    readonly retryAfter?: number,
    readonly lastPostedAt?: Date
  ) {
    super(
      kind === 'rate_limit'
        ? 'Rate limit exceeded'
        : kind === 'duplicate'
          ? 'Duplicate content'
          : 'Failed to create post'
    );
  }
}

export interface CreateFeedPostOptions {
  /** Already verified canonical Feed account, never a model-supplied ID. */
  accountId: string;
  /** Derived by the HTTP adapter, never accepted in tool arguments. */
  clientIpHash?: string;
  /** Database-only audit work, awaited inside the short post insertion transaction. */
  observeMutation?: (transaction: Transaction, postId: string) => Promise<void>;
  /** Optional transport analytics; no credentials or post body are supplied. */
  onCreated?: (event: {
    postId: string;
    contentLength: number;
    hasUsername: boolean;
  }) => void;
}

const CreatePostBodySchema = CreatePostSchema.pick({ content: true });

/** Shared text-post operation. Persistence completes before cache, SSE, mention,
 * and optional enrichment side effects, matching the existing web failure policy.
 * A failed response is ambiguous after commit: callers must not automatically retry. */
export async function createFeedPost(
  input: { content: string },
  options: CreateFeedPostOptions
) {
  const { content: normalizedContent } = CreatePostBodySchema.parse(input);
  const canonicalUserId = options.accountId;
  const [canonicalUser] = await dbWrite
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      isBanned: users.isBanned,
    })
    .from(users)
    .where(eq(users.id, canonicalUserId))
    .limit(1);
  if (!canonicalUser) throw new NotFoundError('User', canonicalUserId);
  if (canonicalUser.isBanned) throw new ForbiddenError('Account access denied');

  const disabled =
    process.env.DISABLE_RATE_LIMITING === 'true' &&
    (process.env.NODE_ENV !== 'production' ||
      process.env.ALLOW_TEST_PRIVY_DID_AUTH === 'true');
  if (!disabled) {
    const limit = await checkRateLimitAsync(
      canonicalUserId,
      RATE_LIMIT_CONFIGS.CREATE_POST
    );
    if (!limit.allowed) {
      logger.warn('Rate limit check failed', {
        userId: canonicalUserId,
        actionType: RATE_LIMIT_CONFIGS.CREATE_POST.actionType,
        retryAfter: limit.retryAfter,
      });
      throw new FeedPostCreationError('rate_limit', limit.retryAfter);
    }
    const duplicate = checkDuplicate(
      canonicalUserId,
      normalizedContent,
      DUPLICATE_DETECTION_CONFIGS.POST
    );
    if (duplicate.isDuplicate) {
      logger.warn('Duplicate content detected', {
        userId: canonicalUserId,
        actionType: DUPLICATE_DETECTION_CONFIGS.POST.actionType,
        lastPostedAt: duplicate.lastPostedAt?.toISOString(),
      });
      throw new FeedPostCreationError(
        'duplicate',
        undefined,
        duplicate.lastPostedAt
      );
    }
    logger.debug('Rate limit and duplicate checks passed', {
      userId: canonicalUserId,
      actionType: RATE_LIMIT_CONFIGS.CREATE_POST.actionType,
      remaining: limit.remaining,
    });
  }

  const clientIpHash = options.clientIpHash;
  if (clientIpHash) {
    const ipRateLimit = await checkRateLimitAsync(
      `post-ip:${clientIpHash}`,
      RATE_LIMIT_CONFIGS.CREATE_POST
    );
    if (!ipRateLimit.allowed) {
      throw new FeedPostCreationError('rate_limit', ipRateLimit.retryAfter);
    }
  }

  const postId = await generateSnowflakeId();
  const post = await dbWrite.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(posts)
      .values({
        id: postId,
        content: normalizedContent,
        authorId: canonicalUserId,
        timestamp: new Date(),
      })
      .returning();
    if (!created) throw new FeedPostCreationError('persistence');
    if (options.observeMutation)
      await options.observeMutation(transaction, created.id);
    return created;
  });

  const authorName = canonicalUser.username!;

  await cachedDb.invalidatePostsCache();
  await cachedDb.invalidateActorPostsCache(canonicalUserId);
  logger.info(
    'Invalidated post caches',
    { postId: post.id },
    'POST /api/posts'
  );

  broadcastToChannel('feed', {
    type: 'new_post',
    post: {
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      authorName: authorName,
      authorUsername: canonicalUser.username,
      authorDisplayName: canonicalUser.displayName,
      authorProfileImageUrl: canonicalUser.profileImageUrl,
      timestamp: toISO(post.timestamp),
    },
  });

  // Invalidate the narrative feed cache so the new post appears in story scoring
  // immediately rather than waiting for the 120s TTL to expire.
  invalidateCache('feed:narrative:v1', { namespace: 'feed' }).catch((err) => {
    logger.warn(
      'Narrative feed cache invalidation failed after new post',
      { error: err, postId: post.id },
      'POST /api/posts'
    );
  });
  logger.info(
    'Broadcast new user post to feed channel',
    { postId: post.id },
    'POST /api/posts'
  );

  const mentions = normalizedContent.match(/@(\w+)/g) || [];
  const usernames = [...new Set(mentions.map((m: string) => m.substring(1)))];

  const mentionedUsers =
    usernames.length > 0
      ? await dbWrite
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.username, usernames as string[]))
      : [];

  await Promise.all(
    mentionedUsers.map((mentionedUser) =>
      notifyMention(mentionedUser.id, canonicalUserId, post.id, undefined)
    )
  );

  logger.info(
    'Sent mention notifications',
    {
      postId: post.id,
      mentionCount: mentionedUsers.length,
      mentionedUsernames: mentionedUsers.map((u) => u.username!),
    },
    'POST /api/posts'
  );

  // Handle player influence for mentioned NPCs (boosts their response probability)
  // Check if any mentioned users are NPCs/actors
  const mentionedActorIds = mentionedUsers
    .filter((u) => {
      // Check if this user is an actor (NPC)
      const actor = StaticDataRegistry.getActor(u.id);
      return actor !== null;
    })
    .map((u) => u.id);

  if (mentionedActorIds.length > 0) {
    // Use Promise.allSettled to handle each mention independently
    // This ensures one failure doesn't prevent processing others
    void Promise.allSettled(
      mentionedActorIds.map((actorId) =>
        handlePlayerMention(canonicalUserId, actorId, post.id)
      )
    ).then((results) => {
      // Log failures from settled results
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const actorId = mentionedActorIds[index];
          logger.warn(
            'Failed to handle player mention for NPC',
            {
              actorId,
              postId: post.id,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
            'POST /api/posts'
          );
        }
      });
      // Log summary after all handlePlayerMention calls have settled
      logger.info(
        'Triggered NPC mention influence',
        { postId: post.id, npcCount: mentionedActorIds.length },
        'POST /api/posts'
      );
    });
  }

  options.onCreated?.({
    postId: post.id,
    contentLength: normalizedContent.length,
    hasUsername: Boolean(canonicalUser.username),
  });

  // Generate and store tags asynchronously (don't block response)
  // This allows posts to be tagged for trending without slowing down the API
  void generateTagsFromPost(normalizedContent)
    .then((generatedTags: GeneratedTag[]) => {
      if (generatedTags.length > 0) {
        return storeTagsForPost(post.id, generatedTags).then(() => {
          logger.info(
            'Tagged user post',
            { postId: post.id, tagCount: generatedTags.length },
            'POST /api/posts'
          );
        });
      }
      return Promise.resolve();
    })
    .catch((tagError: Error) => {
      logger.warn(
        'Failed to tag post',
        { postId: post.id, error: tagError },
        'POST /api/posts'
      );
    });

  void checkProgress(canonicalUserId, { type: 'post_created' }).catch(
    (error: unknown) => {
      logger.warn(
        'Progress check after post creation failed',
        { postId: post.id, error: String(error) },
        'POST /api/posts'
      );
    }
  );

  return {
    success: true,
    post: {
      id: post.id,
      content: post.content,
      authorId: post.authorId,
      authorName: authorName,
      authorUsername: canonicalUser.username,
      authorDisplayName: canonicalUser.displayName,
      authorProfileImageUrl: canonicalUser.profileImageUrl,
      timestamp: toISO(post.timestamp),
      createdAt: toISO(post.createdAt),
    },
  };
}
