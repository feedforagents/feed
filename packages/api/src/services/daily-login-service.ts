/**
 * Daily Login Service
 *
 * Reads daily login streak history (BAB-88). Claiming a daily reward is retired:
 * PRD §9.1 allows no free refills and MVP Phase 1 deletes daily login rewards,
 * so nothing here credits points and nothing advertises a future reward.
 * The reward fields stay in the response shape for existing clients, always
 * retired: nextReward 0, canClaim false, no next milestone.
 */

import { db, eq, users } from '@feed/db';
import { DAILY_LOGIN, isValidSnowflakeId } from '@feed/shared';

// ─── Errors ──────────────────────────────────────────────────────────────────

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND' as const;

  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  nextReward: number;
  daysUntilMilestone: number;
  nextMilestone: number;
  lastClaim: Date | null;
  canClaim: boolean;
  timeUntilClaim: number;
  timeUntilReset: number;
  totalDailyLogins: number;
}

interface ClaimStatus {
  canClaim: boolean;
  shouldResetStreak: boolean;
  timeUntilClaim: number;
  timeUntilReset: number;
}

// ─── Helper Functions (exported for testing) ─────────────────────────────────

export function getClaimStatus(
  lastClaim: Date | null,
  now: number = Date.now()
): ClaimStatus {
  if (!lastClaim) {
    return {
      canClaim: true,
      shouldResetStreak: false,
      timeUntilClaim: 0,
      timeUntilReset: 0,
    };
  }

  // Clamp to 0 to handle clock skew (lastClaim in the future)
  const elapsed = Math.max(0, now - lastClaim.getTime());
  const { MIN_CLAIM_INTERVAL_MS, GRACE_PERIOD_MS } = DAILY_LOGIN;

  if (elapsed < MIN_CLAIM_INTERVAL_MS) {
    return {
      canClaim: false,
      shouldResetStreak: false,
      timeUntilClaim: MIN_CLAIM_INTERVAL_MS - elapsed,
      timeUntilReset: GRACE_PERIOD_MS - elapsed,
    };
  }

  if (elapsed < GRACE_PERIOD_MS) {
    return {
      canClaim: true,
      shouldResetStreak: false,
      timeUntilClaim: 0,
      timeUntilReset: GRACE_PERIOD_MS - elapsed,
    };
  }

  return {
    canClaim: true,
    shouldResetStreak: true,
    timeUntilClaim: 0,
    timeUntilReset: 0,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class DailyLoginService {
  private static validateUserId(userId: string): void {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid userId: must be a non-empty string');
    }
    // Accept both Snowflake IDs and Privy DIDs (did:privy:...)
    // Some users may have Privy IDs as their database ID
    // Check Privy DID first since isValidSnowflakeId throws on non-numeric strings
    if (userId.startsWith('did:privy:')) {
      return; // Valid Privy DID format
    }
    if (!isValidSnowflakeId(userId)) {
      throw new Error(`Invalid userId format: ${userId}`);
    }
  }

  static async getStreakInfo(userId: string): Promise<StreakInfo> {
    this.validateUserId(userId);

    const [user] = await db
      .select({
        dailyLoginStreak: users.dailyLoginStreak,
        lastDailyLogin: users.lastDailyLogin,
        longestStreak: users.longestStreak,
        totalDailyLogins: users.totalDailyLogins,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new UserNotFoundError(userId);

    const status = getClaimStatus(user.lastDailyLogin);
    const currentStreak = Math.max(0, user.dailyLoginStreak);
    const longestStreak = Math.max(0, user.longestStreak);
    const totalDailyLogins = Math.max(0, user.totalDailyLogins);
    // Use effective streak (0 if expired) so the history shown is not stale.
    const effectiveStreak = status.shouldResetStreak ? 0 : currentStreak;

    return {
      currentStreak: effectiveStreak, // Use effective, not raw DB value
      longestStreak,
      nextReward: 0,
      nextMilestone: 0,
      daysUntilMilestone: 0,
      lastClaim: user.lastDailyLogin,
      canClaim: false,
      timeUntilClaim: 0,
      timeUntilReset: 0,
      totalDailyLogins,
    };
  }
}
