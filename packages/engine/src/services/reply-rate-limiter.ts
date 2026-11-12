/**
 * Reply Rate Limiter Service
 *
 * Enforces a minimum 55-minute gap between a player's replies to the same
 * NPC; replies inside the 55–65 minute window extend the hourly streak.
 *
 * canReply is a read-only pre-check. claimReply re-checks the limit and writes
 * the reply and its interaction in one transaction under a per-(user, NPC)
 * advisory lock, so concurrent replies cannot both pass the limit.
 */

import {
  and,
  type DrizzleClient,
  db,
  dbWrite,
  desc,
  eq,
  sql,
  type Transaction,
  userInteractions,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  nextAllowedAt?: Date;
  minutesUntilNextReply?: number;
  lastReplyAt?: Date;
  replyStreak?: number;
  expectedNextReply?: Date;
}

export interface ReplyWrite {
  postId: string;
  commentId: string;
  qualityScore: number;
}

export type ReplyClaim<T extends ReplyWrite> =
  | { allowed: true; rateLimit: RateLimitResult; reply: T }
  | { allowed: false; rateLimit: RateLimitResult };

export class ReplyRateLimiter {
  private static readonly MIN_REPLY_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes
  private static readonly MAX_REPLY_INTERVAL_MS = 65 * 60 * 1000; // 65 minutes
  private static readonly IDEAL_REPLY_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

  static getExpectedNextReplyTime(lastReplyTime: Date): Date {
    return new Date(
      lastReplyTime.getTime() + ReplyRateLimiter.IDEAL_REPLY_INTERVAL_MS
    );
  }

  /**
   * Check if user can reply to an NPC's post
   */
  static async canReply(
    userId: string,
    npcId: string,
    executor: Transaction | DrizzleClient = db
  ): Promise<RateLimitResult> {
    // Get last interaction with this NPC
    const [lastInteraction] = await executor
      .select()
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          eq(userInteractions.npcId, npcId)
        )
      )
      .orderBy(desc(userInteractions.timestamp))
      .limit(1);

    // First reply to this NPC - always allowed
    if (!lastInteraction) {
      return {
        allowed: true,
        replyStreak: 0,
      };
    }

    const now = new Date();
    const timeSinceLastReply =
      now.getTime() - lastInteraction.timestamp.getTime();

    // Calculate expected next reply time using IDEAL_REPLY_INTERVAL_MS
    const expectedNextReply = ReplyRateLimiter.getExpectedNextReplyTime(
      lastInteraction.timestamp
    );

    // Too soon - need to wait
    if (timeSinceLastReply < ReplyRateLimiter.MIN_REPLY_INTERVAL_MS) {
      const nextAllowedAt = new Date(
        lastInteraction.timestamp.getTime() +
          ReplyRateLimiter.MIN_REPLY_INTERVAL_MS
      );
      const minutesUntilNextReply = Math.ceil(
        (nextAllowedAt.getTime() - now.getTime()) / (60 * 1000)
      );

      const minutesUntilExpected = Math.ceil(
        (expectedNextReply.getTime() - now.getTime()) / (60 * 1000)
      );

      return {
        allowed: false,
        reason: `You must wait at least 55 minutes between replies to the same NPC. Expected next reply time: ${minutesUntilExpected} minutes. Please wait ${minutesUntilNextReply} more minutes.`,
        nextAllowedAt,
        minutesUntilNextReply,
        lastReplyAt: lastInteraction.timestamp,
        expectedNextReply,
      };
    }

    // Calculate streak (consecutive hourly replies)
    const streak = await ReplyRateLimiter.calculateReplyStreak(
      userId,
      npcId,
      executor
    );

    // Too late - warn but allow (breaks consistency for following chance)
    if (timeSinceLastReply > ReplyRateLimiter.MAX_REPLY_INTERVAL_MS) {
      return {
        allowed: true,
        reason: `It's been ${Math.floor(timeSinceLastReply / (60 * 60 * 1000))} hours since your last reply. For best chance of being followed, reply every hour.`,
        lastReplyAt: lastInteraction.timestamp,
        replyStreak: 0, // Streak broken
      };
    }

    // Just right - within 55-65 minute window
    return {
      allowed: true,
      lastReplyAt: lastInteraction.timestamp,
      replyStreak: streak + 1, // Continue streak
    };
  }

  /**
   * Calculate consecutive hourly reply streak
   */
  private static async calculateReplyStreak(
    userId: string,
    npcId: string,
    executor: Transaction | DrizzleClient
  ): Promise<number> {
    const interactions = await executor
      .select({
        timestamp: userInteractions.timestamp,
      })
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          eq(userInteractions.npcId, npcId)
        )
      )
      .orderBy(desc(userInteractions.timestamp))
      .limit(24);

    if (interactions.length < 2) return 0;

    let streak = 0;
    for (let i = 0; i < interactions.length - 1; i++) {
      const current = interactions[i];
      const previous = interactions[i + 1];
      if (!current || !previous) continue;
      const gap = current.timestamp.getTime() - previous.timestamp.getTime();

      if (
        gap >= ReplyRateLimiter.MIN_REPLY_INTERVAL_MS &&
        gap <= ReplyRateLimiter.MAX_REPLY_INTERVAL_MS
      ) {
        streak++;
      } else {
        break;
      }
    }

    return streak;
  }

  /**
   * Claim a reply slot and write the reply atomically.
   *
   * Serializes replies from one user to one NPC with a transaction-scoped
   * advisory lock, re-checks the limit, then runs `writeReply` and records the
   * interaction in the same transaction. If `writeReply` throws, nothing is
   * recorded. `writeReply` must only do database writes on `tx`.
   */
  static async claimReply<T extends ReplyWrite>(
    userId: string,
    npcId: string,
    writeReply: (tx: Transaction) => Promise<T>
  ): Promise<ReplyClaim<T>> {
    return dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`reply-rate:${userId}:${npcId}`}))`
      );
      const rateLimit = await ReplyRateLimiter.canReply(userId, npcId, tx);
      if (!rateLimit.allowed) {
        return { allowed: false, rateLimit };
      }
      const reply = await writeReply(tx);
      await tx.insert(userInteractions).values({
        id: await generateSnowflakeId(),
        userId,
        npcId,
        postId: reply.postId,
        commentId: reply.commentId,
        qualityScore: reply.qualityScore,
        timestamp: new Date(),
      });
      return { allowed: true, rateLimit, reply };
    });
  }
}
