/**
 * Closed perp position history in the wallet Positions tab, against a
 * real database and the real positions route.
 *
 * The tab pages the closed list client-side (10 per page) and filters
 * it by outcome, but it used to fetch only server page 1 (limit 50):
 * with more than 50 closed perp positions, every position past the
 * fiftieth was unreachable in the tab and the outcome filter and page
 * count were computed over the truncated set — while the very response
 * it consumed reported total=85 and hasMore=true. The endpoint pages
 * the closed view (`page`/`limit`, see UserPositionsQuerySchema) and
 * the snapshot reports the full total, so the tab must walk every
 * page. These tests drive the real route handler with the tab's own
 * page-walking helper (`fetchAllPositionsPages`).
 *
 * The only stub is the `server-only` marker package; the route, the
 * snapshot builder, and the database all run for real.
 *
 * Run with:
 *   DATABASE_URL=<redacted>
 *     bun test integration/perp-closed-positions-history.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, perpPositions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const { GET } = await import(
  '../../../apps/web/src/app/api/markets/positions/[userId]/route'
);
const { fetchAllPositionsPages } = await import(
  '../../../apps/web/src/components/wallet/v2/closed-positions-pages'
);

type PerpSection = {
  positions: Array<{ id: string; closedAt: string | null }>;
  total: number;
  hasMore: boolean;
};

const PAGE_SIZE = 50; // CLOSED_PAGE_SIZE in the wallet positions tab
const CLOSED_COUNT = 85;

let userId: string;
const closedIds: string[] = [];
const openIds: string[] = [];
const now = Date.now();

async function fetchClosedPage(page: number): Promise<PerpSection> {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/markets/positions/${userId}?status=closed&type=perps&limit=${PAGE_SIZE}&page=${page}`
    )
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { perpetuals: PerpSection };
  return body.perpetuals;
}

beforeAll(async () => {
  userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `test-g29-${userId}`,
    displayName: 'Closed perp history fixture',
    updatedAt: new Date(now),
  });

  // 85 closed perp positions, closed one minute apart, newest first
  // seeded in reverse so insertion order is not display order.
  for (let i = CLOSED_COUNT - 1; i >= 0; i--) {
    const id = await generateSnowflakeId();
    closedIds.unshift(id);
    await db.insert(perpPositions).values({
      id,
      userId,
      organizationId: 'g29-fixture-org',
      ticker: 'G29X',
      side: 'long',
      entryPrice: 100,
      currentPrice: 101,
      size: 500,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: new Date(now - (200 + i) * 60_000),
      lastUpdated: new Date(now - (200 + i) * 60_000),
      closedAt: new Date(now - (10 + i) * 60_000),
      realizedPnL: i % 2 === 0 ? 10 : -5,
    });
  }

  // Open positions must never leak into the closed history.
  for (let i = 0; i < 3; i++) {
    const id = await generateSnowflakeId();
    openIds.push(id);
    await db.insert(perpPositions).values({
      id,
      userId,
      organizationId: 'g29-fixture-org',
      ticker: 'G29X',
      side: 'short',
      entryPrice: 100,
      currentPrice: 99,
      size: 250,
      leverage: 5,
      liquidationPrice: 150,
      unrealizedPnL: 1,
      unrealizedPnLPercent: 1,
      fundingPaid: 0,
      openedAt: new Date(now - (50 - i) * 60_000),
      lastUpdated: new Date(now - (50 - i) * 60_000),
      closedAt: null,
      realizedPnL: null,
    });
  }
});

afterAll(async () => {
  if (!userId) return;
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('closed perp position history paging', () => {
  it('reports the full total on the first page the tab used to stop at', async () => {
    const firstPage = await fetchClosedPage(1);
    expect(firstPage.positions).toHaveLength(PAGE_SIZE);
    expect(firstPage.total).toBe(CLOSED_COUNT);
    expect(firstPage.hasMore).toBe(true);
  });

  it('collects every closed position exactly once, newest first', async () => {
    const rows = await fetchAllPositionsPages((page) => fetchClosedPage(page));

    expect(rows).toHaveLength(CLOSED_COUNT);
    expect(new Set(rows.map((r) => r.id)).size).toBe(CLOSED_COUNT);
    expect(rows.map((r) => r.id)).toEqual(closedIds);
    for (const id of openIds) {
      expect(rows.map((r) => r.id)).not.toContain(id);
    }
    const closedTimes = rows.map((r) => new Date(r.closedAt ?? 0).getTime());
    const sorted = [...closedTimes].sort((a, b) => b - a);
    expect(closedTimes).toEqual(sorted);
  });
});
