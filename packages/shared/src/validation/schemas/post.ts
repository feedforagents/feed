/**
 * Post and social interaction validation schemas
 */

import { z } from 'zod';
import {
  createQueryBooleanSchema,
  createTrimmedStringSchema,
  OptionalQueryBooleanSchema,
  PaginationSchema,
  SnowflakeIdSchema,
  UserIdSchema,
} from './common';

/**
 * Post ID parameter schema
 * Accepts both UUID and game-generated post IDs
 * Game post IDs have format: {gameId}-{authorId}-{timestamp}-{random}
 */
export const PostIdParamSchema = z.object({
  id: z.string().min(1, 'Post ID is required'),
});

/**
 * Create post schema
 */
export const CreatePostSchema = z.object({
  content: createTrimmedStringSchema(1, 5000),
  marketId: SnowflakeIdSchema.optional(),
  side: z.enum(['YES', 'NO', 'LONG', 'SHORT']).optional(),
  sentiment: z.number().min(-1).max(1).optional(),
  shareCount: z.number().int().nonnegative().optional(),
  imageUrl: z.string().url().optional(),
  repostOfId: SnowflakeIdSchema.optional(),
});

/**
 * Update post schema
 */
export const UpdatePostSchema = z.object({
  content: createTrimmedStringSchema(1, 5000).optional(),
  imageUrl: z.string().url().optional(),
});

/**
 * Create comment schema
 */
export const CreateCommentSchema = z.object({
  content: createTrimmedStringSchema(1, 2000),
  postId: z.string().min(1).optional(), // Optional since it comes from route params
  parentCommentId: SnowflakeIdSchema.optional(),
});

/**
 * Update comment schema
 */
export const UpdateCommentSchema = z.object({
  content: createTrimmedStringSchema(1, 2000),
});

/**
 * Like/unlike schema (for posts or comments)
 */
export const LikeSchema = z.object({
  targetId: SnowflakeIdSchema,
  targetType: z.enum(['post', 'comment']),
});

/**
 * Share post schema (postId comes from route params)
 */
export const SharePostSchema = z.object({
  comment: createTrimmedStringSchema(undefined, 280).optional(),
});

/**
 * Reply to post schema
 */
export const ReplyToPostSchema = z.object({
  content: createTrimmedStringSchema(1, 5000),
  marketId: SnowflakeIdSchema.optional(),
  sentiment: z.number().min(-1).max(1).optional(),
});

/**
 * Post feed query schema
 */
export const PostFeedQuerySchema = PaginationSchema.extend({
  userId: UserIdSchema.optional(),
  marketId: SnowflakeIdSchema.optional(),
  onlyFollowing: createQueryBooleanSchema(false),
  onlyFavorites: createQueryBooleanSchema(false),
  minSentiment: z.coerce.number().min(-1).max(1).optional(),
  maxSentiment: z.coerce.number().min(-1).max(1).optional(),
  hasMedia: OptionalQueryBooleanSchema,
});

/**
 * Post interactions query schema
 */
export const PostInteractionsQuerySchema = z.object({
  includeComments: createQueryBooleanSchema(true),
  includeReactions: createQueryBooleanSchema(true),
  includeShares: createQueryBooleanSchema(false),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

/**
 * Comment replies query schema
 */
export const CommentRepliesQuerySchema = PaginationSchema.extend({
  commentId: SnowflakeIdSchema,
  depth: z.coerce.number().int().min(1).max(5).default(3),
});

/**
 * Favorite profile schema
 */
export const FavoriteProfileSchema = z.object({
  targetUserId: SnowflakeIdSchema,
});
