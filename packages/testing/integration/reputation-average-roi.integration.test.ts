/**
 * Integration test (real database) for the reputation `averageROI` write.
 *
 * Exercises the real `updateTradingMetrics` path against the configured
 * database (DATABASE_URL). A user whose `totalDeposited` is 0 used to produce
 * `Infinity`/`NaN` for `averageROI` (raw `lifetimePnL / totalInvested` with no
 * zero guard). Postgres `double precision` accepts `Infinity`, so the bad value
 * was persisted verbatim and later corrupted to `null` in the JSON data export.
 *
 * Red/green reproduction (identical input, `totalDeposited=0`, `lifetimePnL=100`):
 *   - on the unguarded base: the stored `averageROI` is `Infinity`, so the
 *     `Number.isFinite` assertion fails (this is the defect);
 *   - with the fix: the stored `averageROI` is `0` and the assertion passes.
 * A funded user (`totalDeposited=1000`, `lifetimePnL=500`) stores `0.5` in both
 * cases, confirming only the zero-base path changes.
 *
 * Requires a real database (skips via `shouldSkipDatabaseTests()` otherwise):
 *   DATABASE_URL=postgresql://user:pass@host/feed bun test \
 *     packages/testing/integration/reputation-average-roi.integration.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { agentPerformanceMetrics, db, eq, users } from '@feed/db';
// Import the live source directly (not a built dist) so the test always
// reflects the current `reputation-calculation-service.ts`.
import { updateTradingMetrics } from '../../engine/src/reputation/reputation-calculation-service';
import {
  setupTestEnvironment,
  shouldSkipDatabaseTests,
} from '../helpers/setup';

const dbDescribe = shouldSkipDatabaseTests() ? describe.skip : describe;

async function readStoredMetrics(
  userId: string
): Promise<{ averageROI: number | null; totalTrades: number | null }> {
  const [row] = await db
    .select({
      averageROI: agentPerformanceMetrics.averageROI,
      totalTrades: agentPerformanceMetrics.totalTrades,
    })
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);
  return {
    averageROI: row?.averageROI ?? null,
    totalTrades: row?.totalTrades ?? null,
  };
}

async function cleanup(userId: string): Promise<void> {
  await db
    .delete(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

dbDescribe('Reputation averageROI (integration, real DB)', () => {
  let baseId: string;

  beforeAll(async () => {
    await setupTestEnvironment();
    baseId = `avgroi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  it('persists a finite averageROI for a zero-deposit user (no NaN/Infinity)', async () => {
    const userId = `${baseId}-zero`;
    // A funded-only-by-bonus / reset user: positive PnL, zero total deposits.
    await db.insert(users).values({
      id: userId,
      updatedAt: new Date(),
      totalDeposited: '0',
      lifetimePnL: '100',
    });

    let callError: unknown;
    try {
      await updateTradingMetrics(userId, 100, 0, true);
    } catch (err) {
      // The averageROI write commits before recalculateReputation(); capture
      // any downstream error but still verify the stored value.
      callError = err;
    }

    const stored = await readStoredMetrics(userId);
    const preFixRaw = 100 / 0; // what the unguarded division produced
    console.log(
      '[reputation-average-roi] input: totalDeposited=0 lifetimePnL=100'
    );
    console.log(
      `[reputation-average-roi] pre-fix raw division (100/0) = ${preFixRaw} -> JSON ${JSON.stringify(preFixRaw)}`
    );
    console.log(
      `[reputation-average-roi] stored averageROI = ${stored.averageROI} (finite=${Number.isFinite(stored.averageROI ?? NaN)}) totalTrades=${stored.totalTrades} -> JSON ${JSON.stringify(stored.averageROI)}`
    );
    if (callError) {
      console.log(
        `[reputation-average-roi] updateTradingMetrics threw after the write: ${String(callError)}`
      );
    }

    // totalTrades === 1 proves the metrics update actually ran (no false pass
    // from an early throw leaving the default 0).
    expect(stored.totalTrades).toBe(1);
    expect(Number.isFinite(stored.averageROI ?? NaN)).toBe(true);
    expect(stored.averageROI).toBe(0);

    await cleanup(userId);
  });

  it('still computes the real ratio for a funded user (no behavior change)', async () => {
    const userId = `${baseId}-funded`;
    await db.insert(users).values({
      id: userId,
      updatedAt: new Date(),
      totalDeposited: '1000',
      lifetimePnL: '500',
    });

    try {
      await updateTradingMetrics(userId, 500, 1000, true);
    } catch {
      // same reasoning as above
    }

    const stored = await readStoredMetrics(userId);
    console.log(
      `[reputation-average-roi] input: totalDeposited=1000 lifetimePnL=500 -> stored averageROI = ${stored.averageROI}`
    );
    expect(stored.totalTrades).toBe(1);
    expect(stored.averageROI).toBeCloseTo(0.5);

    await cleanup(userId);
  });

  afterEach(async () => {
    // Safety net if a test failed before its own cleanup.
    for (const suffix of ['zero', 'funded']) {
      try {
        await cleanup(`${baseId}-${suffix}`);
      } catch {
        // ignore
      }
    }
  });
});
