/**
 * The Week Trader achievement (login_streak) must report the user's
 * *current* streak — the same effective streak the daily-login surface
 * reports. The stored `dailyLoginStreak` counter only resets on the next
 * claim, so once the 36h grace period since the last claim has passed the
 * streak is broken (DailyLoginService.getStreakInfo reports 0) even though
 * the raw counter still holds the old value. Achievement progress must not
 * keep presenting that dead streak as current progress.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DailyLoginService, getUserAchievements } from '@feed/api';
import { db, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const HOUR = 3600_000;

interface Fixture {
  userId: string;
  streak: number;
  lastClaimHoursAgo: number;
  expectedProgress: number;
}

const fixtures: Fixture[] = [
  // Streak broken 3 days ago: raw counter still says 6, effective streak is 0.
  { userId: '', streak: 6, lastClaimHoursAgo: 72, expectedProgress: 0 },
  // Claimed 2h ago: streak alive, both surfaces agree on 6.
  { userId: '', streak: 6, lastClaimHoursAgo: 2, expectedProgress: 6 },
  // 30h ago: past the 24h claim interval but inside the 36h grace window —
  // the streak is still alive, so progress stays 3.
  { userId: '', streak: 3, lastClaimHoursAgo: 30, expectedProgress: 3 },
  // Raw counter at the threshold but the streak died 5 days ago and the
  // achievement never unlocked: progress must not sit at 7/7.
  { userId: '', streak: 7, lastClaimHoursAgo: 120, expectedProgress: 0 },
];

describe('achievement login-streak progress', () => {
  beforeAll(async () => {
    for (const fixture of fixtures) {
      fixture.userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: fixture.userId,
        username: `achstreak_${fixture.userId.slice(-10)}`,
        isActor: false,
        reputationPoints: 0,
        dailyLoginStreak: fixture.streak,
        lastDailyLogin: new Date(Date.now() - fixture.lastClaimHoursAgo * HOUR),
        updatedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await db.delete(users).where(eq(users.id, fixture.userId));
    }
  });

  it('matches the effective streak reported by DailyLoginService', async () => {
    for (const fixture of fixtures) {
      const info = await DailyLoginService.getStreakInfo(fixture.userId);
      expect(info.currentStreak).toBe(fixture.expectedProgress);

      const achievements = await getUserAchievements(fixture.userId);
      const weekTrader = achievements.find((a) => a.id === 'seven_day_streak');
      expect(weekTrader).toBeDefined();
      expect(weekTrader!.unlocked).toBe(false);
      expect(weekTrader!.progress).toBe(info.currentStreak);
      expect(weekTrader!.progress).toBe(fixture.expectedProgress);
    }
  });
});
