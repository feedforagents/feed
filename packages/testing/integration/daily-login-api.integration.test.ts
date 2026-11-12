/**
 * Daily Login API - Integration Tests
 *
 * Tests the full daily login flow with real database.
 * Covers:
 * - Authentication and authorization
 * - Real database operations via DailyLoginService
 * - Concurrency and race conditions
 * - Idempotency
 * - Error handling
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { DailyLoginService } from '@feed/api';
import { balanceTransactions, db, eq, sql, users } from '@feed/db';
import { generateSnowflakeId, POINTS } from '@feed/shared';
import { waitForEndpointAvailability } from './helpers';
import { createStewardTestToken } from './helpers/steward-auth';

setDefaultTimeout(30000);

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let dbAvailable = false;
let testUserId: string | null = null;

// ─── Setup Helpers ───────────────────────────────────────────────────────────

async function checkServerHealth(): Promise<boolean> {
  return waitForEndpointAvailability(
    `${BASE_URL}/api/users/daily-login`,
    {},
    (response) => response.status !== 404 && response.status < 500,
    15,
    10000
  );
}

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    // Check both DB connection AND that daily login columns exist
    await db.execute(sql`SELECT "dailyLoginStreak" FROM "User" LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** Log skip reason when infrastructure is unavailable */
function skipIfNoServer(): boolean {
  if (!serverAvailable) {
    console.log('⏭️ Skipped: Server not available');
    return true;
  }
  return false;
}

function skipIfNoDb(): boolean {
  if (!dbAvailable) {
    console.log('⏭️ Skipped: Database not available');
    return true;
  }
  return false;
}

async function createTestUser(): Promise<string> {
  const id = await generateSnowflakeId();
  const privyId = `test-privy-${id}`;

  const [inserted] = await db
    .insert(users)
    .values({
      id,
      privyId,
      stewardId: privyId,
      username: `test-daily-login-${id}`,
      displayName: 'Test User',
      profileComplete: true,
      isActor: false,
      isAgent: false,
      dailyLoginStreak: 0,
      longestStreak: 0,
      totalDailyLogins: 0,
      lastDailyLogin: null,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });

  if (!inserted) throw new Error('Daily-login fixture insert returned no user');
  return inserted.id;
}

async function deleteTestUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

async function getUserStreak(userId: string) {
  const [user] = await db
    .select({
      dailyLoginStreak: users.dailyLoginStreak,
      lastDailyLogin: users.lastDailyLogin,
      longestStreak: users.longestStreak,
      totalDailyLogins: users.totalDailyLogins,
      virtualBalance: users.virtualBalance,
      bonusPoints: users.bonusPoints,
      reputationPoints: users.reputationPoints,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user;
}

async function setUserStreak(
  userId: string,
  streak: number,
  lastDailyLogin: Date | null,
  options?: { longestStreak?: number; totalDailyLogins?: number }
): Promise<void> {
  await db
    .update(users)
    .set({
      dailyLoginStreak: streak,
      lastDailyLogin,
      longestStreak: options?.longestStreak ?? streak,
      totalDailyLogins: options?.totalDailyLogins ?? streak,
    })
    .where(eq(users.id, userId));
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe('Daily Login - Integration Tests', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    dbAvailable = await checkDatabaseHealth();

    if (!serverAvailable) {
      console.warn('⚠️  Server not available - HTTP tests will be skipped');
    }
    if (!dbAvailable) {
      console.warn('⚠️  Database not available - DB tests will be skipped');
    }

    if (dbAvailable) {
      testUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && testUserId) {
      await deleteTestUser(testUserId);
    }
  });

  // ─── HTTP Authentication Tests ───────────────────────────────────────────

  describe('HTTP - Authentication', () => {
    // Auth failures should return 401 Unauthorized, not 500.
    // 500 would indicate a server bug that should be investigated.
    test('GET without auth returns 401', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('POST is retired and returns 410', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.code).toBe('DAILY_LOGIN_REWARDS_RETIRED');
    });

    test('invalid Bearer token is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'Bearer invalid-token-xyz' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('malformed auth header is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'NotBearer token' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('empty Bearer token is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'Bearer ' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── HTTP Method Tests ───────────────────────────────────────────────────

  describe('HTTP - Methods', () => {
    test('PUT returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'PUT',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });

    test('DELETE returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });

    test('PATCH returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });
  });

  // ─── HTTP Edge Cases ─────────────────────────────────────────────────────

  describe('HTTP - Edge Cases', () => {
    test('endpoint exists (not 404)', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).not.toBe(404);
    });

    test('concurrent requests handled gracefully', async () => {
      if (skipIfNoServer()) return;

      const requests = Array.from({ length: 10 }, () =>
        fetch(`${BASE_URL}/api/users/daily-login`, {
          signal: AbortSignal.timeout(10000),
        })
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        // Should be auth error or rate limit - 500 would indicate a server crash
        expect([401, 429]).toContain(res.status);
      }
    });
  });
});

// ─── Database Integration Tests ──────────────────────────────────────────────

describe('Daily Login - Database Integration', () => {
  let localTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      localTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && localTestUserId) {
      await deleteTestUser(localTestUserId);
    }
  });

  describe('Initial State', () => {
    test('new user has zero streak', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      expect(user).toBeDefined();
      expect(user!.dailyLoginStreak).toBe(0);
      expect(user!.lastDailyLogin).toBeNull();
      expect(user!.longestStreak).toBe(0);
      expect(user!.totalDailyLogins).toBe(0);
    });
  });

  describe('Streak Updates', () => {
    test('setUserStreak correctly updates database', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const testDate = new Date('2025-01-15T12:00:00.000Z');
      await setUserStreak(localTestUserId, 5, testDate);

      const user = await getUserStreak(localTestUserId);
      expect(user!.dailyLoginStreak).toBe(5);
      expect(user!.lastDailyLogin?.toISOString()).toBe(testDate.toISOString());
      expect(user!.longestStreak).toBe(5);

      // Reset for other tests
      await setUserStreak(localTestUserId, 0, null);
    });
  });

  describe('Data Integrity', () => {
    test('streak values are integers', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      expect(Number.isInteger(user!.dailyLoginStreak)).toBe(true);
      expect(Number.isInteger(user!.longestStreak)).toBe(true);
      expect(Number.isInteger(user!.totalDailyLogins)).toBe(true);
    });

    test('virtualBalance is numeric string', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      const balance = Number(user!.virtualBalance);
      expect(Number.isFinite(balance)).toBe(true);
    });
  });
});

// ─── Service Logic Integration ───────────────────────────────────────────────

describe('Daily Login - DailyLoginService Integration', () => {
  let serviceTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      serviceTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && serviceTestUserId) {
      await deleteTestUser(serviceTestUserId);
    }
  });

  describe('getStreakInfo', () => {
    test('returns correct info for new user', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      await setUserStreak(serviceTestUserId, 0, null);

      const info = await DailyLoginService.getStreakInfo(serviceTestUserId);

      expect(info.currentStreak).toBe(0);
      expect(info.longestStreak).toBe(0);
      expect(info.lastClaim).toBeNull();
      // Rewards are retired: nothing to claim, no future reward advertised.
      expect(info.canClaim).toBe(false);
      expect(info.nextReward).toBe(0);
      expect(info.nextMilestone).toBe(0);
      expect(info.daysUntilMilestone).toBe(0);
    });

    test('throws for invalid userId format', async () => {
      if (skipIfNoDb()) return;

      await expect(
        DailyLoginService.getStreakInfo('invalid-format')
      ).rejects.toThrow('Invalid userId format');
    });

    test('throws for non-existent valid userId', async () => {
      if (skipIfNoDb()) return;

      // Valid snowflake format but doesn't exist
      await expect(
        DailyLoginService.getStreakInfo('123456789012345678')
      ).rejects.toThrow('User not found');
    });

    test('returns effectiveStreak=0 when streak has expired (Bug 1 fix)', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set streak to 50, but lastDailyLogin to 48 hours ago (past 36h grace)
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600000);
      await setUserStreak(serviceTestUserId, 50, fortyEightHoursAgo);

      const info = await DailyLoginService.getStreakInfo(serviceTestUserId);

      // currentStreak should be 0 (effective), not 50 (raw DB value)
      expect(info.currentStreak).toBe(0);
      // longestStreak is historical and should still be 50
      expect(info.longestStreak).toBe(50);
      // Rewards are retired: no milestone, no next reward, nothing to claim
      expect(info.nextMilestone).toBe(0);
      expect(info.daysUntilMilestone).toBe(0);
      expect(info.nextReward).toBe(0);
      expect(info.canClaim).toBe(false);
    });
  });
});

// ─── Concurrency Tests ───────────────────────────────────────────────────────

describe('Daily Login - Concurrency', () => {
  let concurrencyTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      concurrencyTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && concurrencyTestUserId) {
      await deleteTestUser(concurrencyTestUserId);
    }
  });

  test('concurrent reads are consistent', async () => {
    if (skipIfNoDb() || !concurrencyTestUserId) return;

    await setUserStreak(concurrencyTestUserId, 7, new Date());

    // Perform 10 concurrent reads
    const reads = Array.from({ length: 10 }, () =>
      getUserStreak(concurrencyTestUserId!)
    );

    const results = await Promise.all(reads);

    // All reads should return the same value
    for (const result of results) {
      expect(result!.dailyLoginStreak).toBe(7);
    }
  });

  test('database handles rapid updates', async () => {
    if (skipIfNoDb() || !concurrencyTestUserId) return;

    // Execute rapid sequential updates
    for (let i = 1; i <= 5; i++) {
      await db
        .update(users)
        .set({ dailyLoginStreak: i })
        .where(eq(users.id, concurrencyTestUserId));
    }

    const user = await getUserStreak(concurrencyTestUserId);
    expect(user!.dailyLoginStreak).toBe(5);
  });
});

// ─── Error Handling Tests ────────────────────────────────────────────────────

describe('Daily Login - Error Handling', () => {
  test('non-existent user returns undefined from DB query', async () => {
    if (skipIfNoDb()) return;

    const fakeUserId = 'non-existent-user-12345';
    const user = await getUserStreak(fakeUserId);
    expect(user).toBeUndefined();
  });

  test('service clamps negative streak values to zero', async () => {
    if (skipIfNoDb()) return;

    const tempUserId = await createTestUser();

    try {
      await db
        .update(users)
        .set({ dailyLoginStreak: -1 })
        .where(eq(users.id, tempUserId))
        .execute();

      const streakInfo = await DailyLoginService.getStreakInfo(tempUserId);
      expect(streakInfo.currentStreak).toBe(0);
      expect(streakInfo.nextReward).toBe(0);
    } finally {
      await deleteTestUser(tempUserId);
    }
  });
});

// ─── Authenticated HTTP: rewards retired ─────────────────────────────────────

describe('Daily Login - Authenticated HTTP (rewards retired)', () => {
  // No early-return skips here: if the server or database is missing these
  // tests fail, so an unexecuted assertion can never report as a pass.
  const accounts: { id: string; streak: number }[] = [];

  async function createOwnedAccount(
    ownership: { id: string; streak: number }[],
    streak: number
  ) {
    const id = await createTestUser();
    const account = { id, streak };
    ownership.push(account);
    if (streak > 0) {
      await setUserStreak(id, streak, new Date(Date.now() - 25 * 3600000));
    }
    return account;
  }

  async function cleanupAccounts(ownership: { id: string }[]) {
    const failures: Error[] = [];
    for (const { id } of ownership) {
      for (const remove of [
        async () => {
          await db
            .delete(balanceTransactions)
            .where(eq(balanceTransactions.userId, id));
        },
        () => deleteTestUser(id),
      ]) {
        try {
          await remove();
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error
              : new Error('Owned daily-login fixture cleanup failed')
          );
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Owned daily-login account cleanup incomplete'
      );
    }
  }

  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    dbAvailable = await checkDatabaseHealth();
    if (!dbAvailable) return;
    // A new account and an existing 3-day streak claimed 25 hours ago (the
    // state where the old GET advertised a claimable 125-point reward).
    for (const streak of [0, 3]) {
      await createOwnedAccount(accounts, streak);
    }
  });

  afterAll(async () => {
    await cleanupAccounts(accounts);
  });

  async function ledgerRows(userId: string) {
    return db
      .select({ id: balanceTransactions.id })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
  }

  test('server and database are available', () => {
    expect(serverAvailable).toBe(true);
    expect(dbAvailable).toBe(true);
    expect(accounts).toHaveLength(2);
  });

  test('failed second-account setup cleans owned inserts and preserves a control', async () => {
    const failedAccounts: { id: string; streak: number }[] = [];
    const controls: { id: string; streak: number }[] = [];
    try {
      const control = await createOwnedAccount(controls, 0);
      const controlBefore = await getUserStreak(control.id);
      const controlLedgerBefore = await ledgerRows(control.id);
      expect(controlBefore).toBeDefined();

      await createOwnedAccount(failedAccounts, 0);
      // PostgreSQL's integer column rejects this update after the INSERT.
      await expect(
        createOwnedAccount(failedAccounts, 2 ** 31)
      ).rejects.toMatchObject({ cause: { code: '22003' } });
      expect(failedAccounts).toHaveLength(2);
      for (const { id } of failedAccounts) {
        expect(await getUserStreak(id)).toBeDefined();
      }

      await cleanupAccounts(failedAccounts);
      for (const { id } of failedAccounts) {
        expect(await getUserStreak(id)).toBeUndefined();
        expect(await ledgerRows(id)).toHaveLength(0);
      }
      expect(await getUserStreak(control.id)).toEqual(controlBefore);
      expect(await ledgerRows(control.id)).toEqual(controlLedgerBefore);
    } finally {
      await cleanupAccounts([...failedAccounts, ...controls]);
    }
  });

  test('GET advertises no claimable or future reward', async () => {
    expect(accounts).toHaveLength(2);
    for (const { id, streak } of accounts) {
      const token = await createStewardTestToken(`test-privy-${id}`);
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.canClaim).toBe(false);
      expect(body.nextReward).toBe(0);
      expect(body.nextMilestone).toBe(0);
      expect(body.daysUntilMilestone).toBe(0);
      // Historical counters are kept.
      expect(body.currentStreak).toBe(streak);
      expect(body.longestStreak).toBe(streak);
    }
  });

  test('repeated and concurrent POSTs return 410 and change nothing', async () => {
    expect(accounts).toHaveLength(2);
    for (const { id } of accounts) {
      const before = await getUserStreak(id);
      const ledgerBefore = await ledgerRows(id);
      const headers = {
        Authorization: `Bearer ${await createStewardTestToken(`test-privy-${id}`)}`,
      };

      const post = () =>
        fetch(`${BASE_URL}/api/users/daily-login`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(10000),
        });
      const first = await post();
      const repeats = await Promise.all(Array.from({ length: 5 }, post));
      for (const res of [first, ...repeats]) {
        expect(res.status).toBe(410);
        expect((await res.json()).code).toBe('DAILY_LOGIN_REWARDS_RETIRED');
      }

      expect(await getUserStreak(id)).toEqual(before);
      expect(await ledgerRows(id)).toEqual(ledgerBefore);
    }
  });
});

// ─── Output Verification ─────────────────────────────────────────────────────

describe('Daily Login - Output Verification', () => {
  test('reward values match constants', () => {
    expect(POINTS.DAILY_LOGIN_DAY_1).toBe(50);
    expect(POINTS.DAILY_LOGIN_DAY_7).toBe(200);
    expect(POINTS.DAILY_LOGIN_MILESTONE_7D).toBe(500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_90D).toBe(5000);
  });

  test('cumulative week 1 rewards are exactly 1375', () => {
    let total = 0;
    for (let i = 1; i <= 7; i++) {
      const key = `DAILY_LOGIN_DAY_${i}` as keyof typeof POINTS;
      total += POINTS[key];
    }
    total += POINTS.DAILY_LOGIN_MILESTONE_7D;
    expect(total).toBe(1375);
  });

  test('all milestone values', () => {
    expect(POINTS.DAILY_LOGIN_MILESTONE_7D).toBe(500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_14D).toBe(750);
    expect(POINTS.DAILY_LOGIN_MILESTONE_30D).toBe(1500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_60D).toBe(3000);
    expect(POINTS.DAILY_LOGIN_MILESTONE_90D).toBe(5000);
  });
});
