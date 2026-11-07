/**
 * Daily Login Service
 *
 * Reads daily login streak history (BAB-88). Claiming a daily reward is retired:
 * PRD §9.1 allows no free refills and MVP Phase 0 deletes daily login rewards,
 * so nothing here credits points.
 */

import { db, eq, users } from '@feed/db';
import { DAILY_LOGIN, isValidSnowflakeId, POINTS } from '@feed/shared';

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

// ─── Constants ───────────────────────────────────────────────────────────────

const MILESTONES = [
  { days: 7, bonus: POINTS.DAILY_LOGIN_MILESTONE_7D },
  { days: 14, bonus: POINTS.DAILY_LOGIN_MILESTONE_14D },
  { days: 30, bonus: POINTS.DAILY_LOGIN_MILESTONE_30D },
  { days: 60, bonus: POINTS.DAILY_LOGIN_MILESTONE_60D },
  { days: 90, bonus: POINTS.DAILY_LOGIN_MILESTONE_90D },
] as const;

const DAILY_REWARDS = [
  POINTS.DAILY_LOGIN_DAY_1, // index 0 = Day 1
  POINTS.DAILY_LOGIN_DAY_2,
  POINTS.DAILY_LOGIN_DAY_3,
  POINTS.DAILY_LOGIN_DAY_4,
  POINTS.DAILY_LOGIN_DAY_5,
  POINTS.DAILY_LOGIN_DAY_6,
  POINTS.DAILY_LOGIN_DAY_7,
] as const;

// ─── Helper Functions (exported for testing) ─────────────────────────────────

export function getDailyReward(streakDay: number): number {
  // Math.floor ensures floats like 1.9 are handled predictably (treated as day 1)
  const idx = Math.floor(Math.max(0, streakDay - 1)) % DAILY_LOGIN.CYCLE_LENGTH;
  return DAILY_REWARDS[idx] ?? DAILY_REWARDS[0];
}

export function getMilestoneBonus(streak: number): number {
  return MILESTONES.find((m) => m.days === streak)?.bonus ?? 0;
}

export function getNextMilestone(streak: number): {
  nextMilestone: number;
  daysUntilMilestone: number;
} {
  // Clamp to 0 to handle negative input defensively (e.g., corrupted data)
  const safeStreak = Math.max(0, streak);
  const next = MILESTONES.find((m) => safeStreak < m.days);
  return next
    ? { nextMilestone: next.days, daysUntilMilestone: next.days - safeStreak }
    : { nextMilestone: 0, daysUntilMilestone: 0 };
}

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
    // Use effective streak (0 if expired) for all calculations to avoid
    // inconsistent UI state (e.g., "50 day streak" but "7 days to 7-day milestone")
    const effectiveStreak = status.shouldResetStreak ? 0 : currentStreak;
    const milestone = getNextMilestone(effectiveStreak);

    return {
      currentStreak: effectiveStreak, // Use effective, not raw DB value
      longestStreak,
      nextReward: getDailyReward(effectiveStreak + 1),
      ...milestone,
      lastClaim: user.lastDailyLogin,
      canClaim: status.canClaim,
      timeUntilClaim: status.timeUntilClaim,
      timeUntilReset: status.timeUntilReset,
      totalDailyLogins,
    };
  }
}
