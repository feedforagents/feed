/**
 * Metrics Snapshot Cron — Active Markets Integration Test
 *
 * Evidence for the metrics-snapshot activeMarkets fix
 * (feedforagents/feed): POST /api/cron/metrics-snapshot must exclude
 * expired-but-unresolved markets from `metrics.activeMarkets`.
 *
 * Same defect class as PR #2102 (admin trading stats): the snapshot query
 * counted every unresolved market as active, so the admin timeseries chart
 * (GET /api/admin/stats/timeseries serves these snapshots) showed
 * expired markets as still open for trading — disagreeing with the live
 * admin stats endpoints, which filter `endDate >= now` (PRD §8.1/§9.2:
 * active means open for trading).
 *
 * This test exercises the live route against a real Postgres database:
 *
 * - With the fix: seeding one live market and one expired-but-unresolved
 *   market raises the snapshot's `activeMarkets` by exactly 1.
 * - Without the fix (route reverted): the same seed raises it by 2,
 *   because the expired market is still counted.
 *
 * The before/after pair is selected with METRICS_SNAPSHOT_EXPECT_BUGGY=1
 * for the pre-fix run; the default run asserts the fixed behavior. Each
 * snapshot call logs one `[evidence]` line with its correlation ID
 * (sent as `x-correlation-id`), HTTP status, and resulting counts.
 *
 * The route creates at most one snapshot per (hour, environment), so the
 * test deletes the current hour's snapshot row in the LOCAL test database
 * before each call (the row is immediately recreated by the call itself);
 * nothing outside the local test database is touched.
 *
 * Run with: bun run test:integration -- packages/testing/integration/metrics-snapshot-active-markets.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, eq, generateSnowflakeId, systemMetricsSnapshots } from '@feed/db';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

const CRON_SECRET = process.env.CRON_SECRET || 'development';

let serverAvailable = false;

const seededMarketIds: string[] = [];
const createdSnapshotIds: string[] = [];

function hourBoundary(date: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      0,
      0,
      0
    )
  );
}

async function clearCurrentHourSnapshot(): Promise<void> {
  await db
    .delete(systemMetricsSnapshots)
    .where(eq(systemMetricsSnapshots.timestamp, hourBoundary()));
}

async function callSnapshot(correlationId: string) {
  const response = await fetch(`${BASE_URL}/api/cron/metrics-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
      'x-correlation-id': correlationId,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as {
    success?: boolean;
    skipped?: boolean;
    reason?: string;
    snapshotId?: string;
    timestamp?: string;
    metrics?: { activeMarkets?: number };
  };
  return { status: response.status, body };
}

describe('Metrics Snapshot — active markets exclude expired markets', () => {
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
  });

  afterAll(async () => {
    for (const id of seededMarketIds) {
      await db.market.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdSnapshotIds) {
      await db
        .delete(systemMetricsSnapshots)
        .where(eq(systemMetricsSnapshots.id, id))
        .catch(() => {});
    }
  });

  test('expired-but-unresolved markets are excluded from snapshot activeMarkets', async () => {
    const expectBuggy = process.env.METRICS_SNAPSHOT_EXPECT_BUGGY === '1';

    // Baseline: fresh snapshot with no seeds, so the deltas hold on any
    // database state.
    await clearCurrentHourSnapshot();
    const baselineCorrelationId = randomUUID();
    const baseline = await callSnapshot(baselineCorrelationId);
    expect(baseline.status).toBe(200);
    expect(baseline.body.success).toBe(true);
    expect(baseline.body.skipped).toBeFalsy();
    expect(baseline.body.metrics?.activeMarkets).toBeDefined();
    const baselineActive = baseline.body.metrics?.activeMarkets ?? 0;
    if (baseline.body.snapshotId) {
      createdSnapshotIds.push(baseline.body.snapshotId);
    }
    console.log(
      `[evidence] correlationId=${baselineCorrelationId} phase=baseline status=${baseline.status} activeMarkets=${baselineActive}`
    );

    const now = Date.now();
    const liveMarketId = await generateSnowflakeId();
    const expiredMarketId = await generateSnowflakeId();
    await db.market.create({
      data: {
        id: liveMarketId,
        question: 'slop-metrics-snapshot Test: live market still open',
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
        question: 'slop-metrics-snapshot Test: expired but unresolved market',
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

    // Force a fresh snapshot so it reflects the seeds.
    await clearCurrentHourSnapshot();
    const correlationId = randomUUID();
    const result = await callSnapshot(correlationId);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.skipped).toBeFalsy();
    expect(result.body.metrics?.activeMarkets).toBeDefined();
    const afterActive = result.body.metrics?.activeMarkets ?? 0;
    if (result.body.snapshotId) {
      createdSnapshotIds.push(result.body.snapshotId);
    }

    // Resulting state, read back from the stored snapshot row.
    const [stored] = await db
      .select({ activeMarkets: systemMetricsSnapshots.activeMarkets })
      .from(systemMetricsSnapshots)
      .where(eq(systemMetricsSnapshots.id, result.body.snapshotId ?? ''))
      .limit(1);
    // And from the real database with the same predicate the fix uses.
    const dbActiveCount = await db.market.count({
      where: { resolved: false, endDate: { gte: new Date() } },
    });
    console.log(
      `[evidence] correlationId=${correlationId} phase=after-seed status=${result.status} activeMarkets=${afterActive} storedActiveMarkets=${stored?.activeMarkets} dbActiveCount=${dbActiveCount}`
    );

    expect(stored?.activeMarkets).toBe(afterActive);
    // With the fix only the live market is active (+1); without it the
    // expired market is counted too (+2).
    expect(afterActive).toBe(baselineActive + (expectBuggy ? 2 : 1));
    // The database predicate agrees with the fixed route.
    expect(dbActiveCount).toBe(baselineActive + 1);
  });
});
