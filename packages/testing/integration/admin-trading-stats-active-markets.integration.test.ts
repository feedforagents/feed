/**
 * Admin Trading Stats — Active Markets Integration Test
 *
 * Evidence for PR #2102 (feedforagents/feed): GET /api/admin/stats/trading
 * must exclude expired-but-unresolved markets from `overview.activeMarkets`.
 *
 * Slopbot reviewed the PR as `missing_evidence`: the unit test proves the
 * query predicate against a stubbed database only. This test exercises the
 * live route against a real Postgres database and records redacted runtime
 * logs (correlation ID + resulting state) for both sides of the fix:
 *
 * - With the fix: seeding one live market and one expired-but-unresolved
 *   market raises `activeMarkets` by exactly 1.
 * - Without the fix (route reverted to HEAD~1): the same seed raises
 *   `activeMarkets` by 2, because the expired market is still counted.
 *
 * The before/after pair is selected with TRADING_STATS_EXPECT_BUGGY=1 for
 * the pre-fix run; the default run asserts the fixed behavior. Each
 * invocation logs one `[evidence]` line with its correlation ID, HTTP
 * status, and the resulting counts; the dev server logs the matching
 * "Trading stats requested" line for the same request.
 *
 * Run with: bun run test:integration -- packages/testing/integration/admin-trading-stats-active-markets.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { getAdminToken } from './helpers';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let adminToken: string | null = null;

const seededMarketIds: string[] = [];

async function getTradingStats(correlationId: string) {
  const response = await fetch(`${BASE_URL}/api/admin/stats/trading`, {
    headers: {
      'Content-Type': 'application/json',
      'x-dev-admin-token': adminToken ?? '',
      'x-correlation-id': correlationId,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    overview?: { totalMarkets?: number; activeMarkets?: number };
  };
  return { status: response.status, overview: body.overview };
}

describe('Admin Trading Stats — active markets exclude expired markets', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    serverAvailable = health?.ok === true;
    if (!serverAvailable) {
      throw new Error(
        `Integration test requires the dev server at ${BASE_URL}`
      );
    }

    adminToken = getAdminToken();
    if (!adminToken) {
      throw new Error(
        'Integration test requires a dev admin token for authenticated coverage'
      );
    }
  });

  afterAll(async () => {
    for (const id of seededMarketIds) {
      await db.market.delete({ where: { id } }).catch(() => {});
    }
  });

  test('expired-but-unresolved markets are excluded from activeMarkets', async () => {
    const expectBuggy = process.env.TRADING_STATS_EXPECT_BUGGY === '1';

    // Baseline before seeding, so the deltas hold on any database state.
    const baselineCorrelationId = randomUUID();
    const baseline = await getTradingStats(baselineCorrelationId);
    expect(baseline.status).toBe(200);
    expect(baseline.overview).toBeDefined();
    const baselineActive = baseline.overview?.activeMarkets ?? 0;
    const baselineTotal = baseline.overview?.totalMarkets ?? 0;
    console.log(
      `[evidence] correlationId=${baselineCorrelationId} phase=baseline status=${baseline.status} totalMarkets=${baselineTotal} activeMarkets=${baselineActive}`
    );

    const now = Date.now();
    const liveMarketId = await generateSnowflakeId();
    const expiredMarketId = await generateSnowflakeId();
    await db.market.create({
      data: {
        id: liveMarketId,
        question: 'slop-2102 Test: live market still open',
        yesShares: '5000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate: new Date(now + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await db.market.create({
      data: {
        id: expiredMarketId,
        question: 'slop-2102 Test: expired but unresolved market',
        yesShares: '5000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate: new Date(now - 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    seededMarketIds.push(liveMarketId, expiredMarketId);

    const correlationId = randomUUID();
    const result = await getTradingStats(correlationId);
    expect(result.status).toBe(200);
    expect(result.overview).toBeDefined();

    // Resulting state, read back from the real database with the same
    // predicate the fix uses.
    const dbActiveCount = await db.market.count({
      where: { resolved: false, endDate: { gte: new Date() } },
    });
    console.log(
      `[evidence] correlationId=${correlationId} phase=after-seed status=${result.status} totalMarkets=${result.overview?.totalMarkets} activeMarkets=${result.overview?.activeMarkets} dbActiveCount=${dbActiveCount}`
    );

    // Both markets exist, so the total rises by 2 either way.
    expect(result.overview?.totalMarkets).toBe(baselineTotal + 2);
    // With the fix only the live market is active (+1); without it the
    // expired market is counted too (+2).
    expect(result.overview?.activeMarkets).toBe(
      baselineActive + (expectBuggy ? 2 : 1)
    );
    // The database predicate agrees with the fixed route.
    expect(dbActiveCount).toBe(baselineActive + 1);
  });
});
