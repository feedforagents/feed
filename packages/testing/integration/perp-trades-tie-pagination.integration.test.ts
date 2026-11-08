/**
 * GET /api/markets/perps/trades/[ticker] against a real database: the perp
 * market page's trades feed (AssetTradesFeed) walks this route page by page
 * with limit/offset and appends what it gets. Every row of the merged feed
 * (perp positions, NPC trades, perp balance transactions) must be reachable
 * exactly once across the walk, with the same total on every page.
 *
 * All fixture rows share one identical timestamp — bulk opens, batch NPC
 * executions, and seeded/migrated history routinely land on the same
 * millisecond. On base, each source is fetched with a timestamp-only
 * ordering and each page re-runs the queries with a different window size,
 * so tied rows are selected inconsistently between pages: some trades are
 * returned twice and others never appear, while `total` still claims the
 * full count.
 *
 * The only stub is the `server-only` marker package; the route, its
 * database queries, and the static registry all run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  db,
  eq,
  inArray,
  npcTrades,
  organizationState,
  perpPositions,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';

type TradesBody = {
  trades: Array<{ id: string; type: string }>;
  total: number;
  hasMore: boolean;
};

let GET: typeof import('../../../apps/web/src/app/api/markets/perps/trades/[ticker]/route').GET;

const TICKER = 'AMZN';
const ORG_ID = 'aimazon';
const TIE_TIME = new Date('2026-01-15T12:00:00.000Z');

const POSITION_COUNT = 120;
const NPC_COUNT = 60;
const TOTAL = POSITION_COUNT * 2 + NPC_COUNT; // positions + their open txs + npc trades

const userIds = ['f36-user-a', 'f36-user-b'];
const positionIds = Array.from(
  { length: POSITION_COUNT },
  (_, i) => `f36-pos-${String(i + 1).padStart(3, '0')}`
);
const balanceTxIds = Array.from(
  { length: POSITION_COUNT },
  (_, i) => `f36-btx-${String(i + 1).padStart(3, '0')}`
);
const npcIds = Array.from(
  { length: NPC_COUNT },
  (_, i) => `f36-npc-${String(i + 1).padStart(3, '0')}`
);
const expectedIds = new Set([...positionIds, ...balanceTxIds, ...npcIds]);

async function fetchPage(limit: number, offset: number) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/markets/perps/trades/${TICKER}?limit=${limit}&offset=${offset}`
    )
  );
  const response = await GET(request, {
    params: Promise.resolve({ ticker: TICKER }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: TradesBody;
  } & Partial<TradesBody>;
  const data = (body?.data ?? body) as TradesBody;
  return { status: response.status, data };
}

async function walk(limit: number) {
  const seen: string[] = [];
  const totals = new Set<number>();
  let offset = 0;
  let hasMore = true;
  let pages = 0;
  while (hasMore && pages < 50) {
    const { status, data } = await fetchPage(limit, offset);
    expect(status).toBe(200);
    totals.add(data.total);
    seen.push(...data.trades.map((t) => t.id));
    hasMore = data.hasMore;
    offset += data.trades.length;
    pages += 1;
    if (data.trades.length === 0) break;
  }
  return { seen, totals, pages };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/markets/perps/trades/[ticker]/route'
  ));

  const now = new Date();
  await db.insert(users).values(
    userIds.map((id, i) => ({
      id,
      username: `f36-user-${i}`,
      displayName: `F36 Fixture User ${i}`,
      updatedAt: now,
    }))
  );

  await db.insert(organizationState).values({
    id: ORG_ID,
    currentPrice: 185,
    updatedAt: now,
  });

  await db.insert(perpPositions).values(
    positionIds.map((id, i) => ({
      id,
      userId: userIds[i % userIds.length] as string,
      ticker: TICKER,
      organizationId: ORG_ID,
      side: i % 2 === 0 ? 'long' : 'short',
      entryPrice: 100,
      currentPrice: 101,
      size: 25,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 3.5,
      unrealizedPnLPercent: 1.4,
      openedAt: TIE_TIME,
      lastUpdated: TIE_TIME,
    }))
  );

  await db.insert(balanceTransactions).values(
    balanceTxIds.map((id, i) => ({
      id,
      userId: userIds[i % userIds.length] as string,
      type: 'perp_open',
      amount: '25.00',
      balanceBefore: '1000.00',
      balanceAfter: '975.00',
      relatedId: positionIds[i] as string,
      description: `Open perp ${positionIds[i]}`,
      createdAt: TIE_TIME,
    }))
  );

  await db.insert(npcTrades).values(
    npcIds.map((id) => ({
      id,
      npcActorId: 'ailon-musk',
      marketType: 'perp',
      ticker: TICKER,
      action: 'open_long',
      side: 'long',
      amount: 10,
      price: 100,
      sentiment: 0.5,
      reason: 'f36 fixture',
      executedAt: TIE_TIME,
    }))
  );
});

afterAll(async () => {
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.id, balanceTxIds));
  await db.delete(npcTrades).where(inArray(npcTrades.id, npcIds));
  await db.delete(perpPositions).where(inArray(perpPositions.id, positionIds));
  await db.delete(organizationState).where(eq(organizationState.id, ORG_ID));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('GET /api/markets/perps/trades/[ticker] same-timestamp pagination', () => {
  it('reaches every merged trade exactly once when all rows share a timestamp (limit 25)', async () => {
    const { seen, totals } = await walk(25);
    expect(totals).toEqual(new Set([TOTAL]));
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(new Set(seen)).toEqual(expectedIds); // nothing missing
  });

  it('reaches every merged trade exactly once when all rows share a timestamp (limit 40)', async () => {
    const { seen, totals } = await walk(40);
    expect(totals).toEqual(new Set([TOTAL]));
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(expectedIds);
  });
});
