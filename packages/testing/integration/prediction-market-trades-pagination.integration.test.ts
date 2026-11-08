/**
 * GET /api/markets/predictions/[id]/trades against a real database: the
 * merged recent-trades list on the market detail screen must be traversable
 * to the end — every trade (user balance transactions and NPC trades)
 * reachable exactly once through offset pagination.
 *
 * The route merged the two sources with `ORDER BY "timestampMs" DESC`
 * alone. Trades executed in the same millisecond — the normal case when an
 * engine tick settles many NPC trades and user trades at once — tie on the
 * only sort key, so the database is free to return tied rows in a different
 * order on each page query. Measured on base with 300 trades sharing one
 * millisecond: a full traversal observed 299 distinct rows — one trade was
 * duplicated across pages and one never appeared on any page (the web feed
 * deduplicates by id, so the duplicate is invisible there, but no client
 * can recover the missing one).
 *
 * The sibling surfaces state the rule for the same merged-list shape: the
 * chat history and reputation history fixes order by (timestamp, id) so
 * the ordering is total. The route's own unit test asserts only cache and
 * parameter behaviour — nothing pins the tie order as intended.
 *
 * The only stub is the `server-only` marker package; the route, its cache
 * service, and every database dependency run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  db,
  eq,
  markets,
  npcTrades,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/trades/route').GET;

let marketId: string;
let otherMarketId: string;
let userId: string;
let npcId: string;

const SAME_MS_BALANCE = 150;
const SAME_MS_NPC = 150;
const sameMsIds = new Set<string>();
const orderedIds: string[] = []; // trades at distinct, increasing times
const otherMarketIds = new Set<string>();

type TradesBody = {
  trades: Array<{ id: string; type: string }>;
  total: number;
  hasMore: boolean;
};

async function fetchPage(offset: number, limit = 20): Promise<TradesBody> {
  const req = new NextRequest(
    new Request(
      `http://localhost/api/markets/predictions/${marketId}/trades?limit=${limit}&offset=${offset}`
    )
  );
  const res = await GET(req, { params: Promise.resolve({ id: marketId }) });
  expect(res.status).toBe(200);
  return (await res.json()) as TradesBody;
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/trades/route'
  ));
  marketId = await generateSnowflakeId();
  otherMarketId = await generateSnowflakeId();
  userId = await generateSnowflakeId();
  npcId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(users).values([
    {
      id: userId,
      username: `f37u-${userId}`,
      displayName: 'F37 Trades User',
      updatedAt: now,
    },
    {
      id: npcId,
      username: `f37n-${npcId}`,
      displayName: 'F37 Trades NPC',
      isActor: true,
      updatedAt: now,
    },
  ]);
  await db.insert(markets).values([
    {
      id: marketId,
      question: 'F37 trades market?',
      liquidity: '1000',
      endDate: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    },
    {
      id: otherMarketId,
      question: 'F37 other market?',
      liquidity: '1000',
      endDate: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    },
  ]);

  // Bulk fixture: 300 trades sharing a single millisecond — the shape an
  // engine tick produces when many trades settle at once.
  const T = new Date('2026-01-15T12:00:00.000Z');
  const balRows = [];
  for (let i = 0; i < SAME_MS_BALANCE; i++) {
    const id = await generateSnowflakeId();
    sameMsIds.add(id);
    balRows.push({
      id,
      userId,
      type: 'pred_buy',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '90.00',
      relatedId: marketId,
      createdAt: T,
    });
  }
  await db.insert(balanceTransactions).values(balRows);

  const npcRows = [];
  for (let i = 0; i < SAME_MS_NPC; i++) {
    const id = await generateSnowflakeId();
    sameMsIds.add(id);
    npcRows.push({
      id,
      npcActorId: npcId,
      marketType: 'prediction',
      marketId,
      action: 'buy_yes',
      side: 'yes',
      amount: 10,
      price: 0.5,
      executedAt: T,
    });
  }
  await db.insert(npcTrades).values(npcRows);

  // A few trades at distinct, later times for the ordering guard.
  for (let i = 0; i < 3; i++) {
    const id = await generateSnowflakeId();
    orderedIds.push(id);
    await db.insert(balanceTransactions).values({
      id,
      userId,
      type: 'pred_sell',
      amount: '5.00',
      balanceBefore: '90.00',
      balanceAfter: '95.00',
      relatedId: marketId,
      createdAt: new Date(T.getTime() + (i + 1) * 60_000),
    });
  }

  // Another market's trades must never leak into this market's list.
  for (let i = 0; i < 5; i++) {
    const id = await generateSnowflakeId();
    otherMarketIds.add(id);
    await db.insert(balanceTransactions).values({
      id,
      userId,
      type: 'pred_buy',
      amount: '1.00',
      balanceBefore: '95.00',
      balanceAfter: '94.00',
      relatedId: otherMarketId,
      createdAt: T,
    });
  }
});

afterAll(async () => {
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.relatedId, marketId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.relatedId, otherMarketId));
  await db.delete(npcTrades).where(eq(npcTrades.marketId, marketId));
  await db.delete(markets).where(eq(markets.id, marketId));
  await db.delete(markets).where(eq(markets.id, otherMarketId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, npcId));
});

describe('prediction market trades pagination', () => {
  it('reaches every same-millisecond trade exactly once across offset pages', async () => {
    const seen = new Map<string, number>();
    let offset = 0;
    for (let pages = 0; pages < 40; pages++) {
      const page = await fetchPage(offset);
      for (const t of page.trades) {
        seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
      }
      if (!page.hasMore || page.trades.length === 0) break;
      offset += page.trades.length;
    }

    const expectedTotal = SAME_MS_BALANCE + SAME_MS_NPC + orderedIds.length;
    expect(seen.size).toBe(expectedTotal);
    // The merged traversal contains both sources (balance and npc).
    const traversedTypes = new Set<string>();
    for (let pages = 0, offset2 = 0; pages < 40; pages++) {
      const page = await fetchPage(offset2);
      for (const t of page.trades) traversedTypes.add(t.type);
      if (!page.hasMore || page.trades.length === 0) break;
      offset2 += page.trades.length;
    }
    expect(traversedTypes.has('balance')).toBe(true);
    expect(traversedTypes.has('npc')).toBe(true);
    for (const id of sameMsIds) {
      expect(seen.get(id)).toBe(1);
    }
    for (const id of orderedIds) {
      expect(seen.get(id)).toBe(1);
    }
    for (const id of otherMarketIds) {
      expect(seen.has(id)).toBe(false);
    }
  });

  it('keeps newest-first order across distinct timestamps', async () => {
    const firstPage = await fetchPage(0, 10);
    // The three distinct-time trades are the newest, in newest-first order.
    expect(firstPage.trades.slice(0, 3).map((t) => t.id)).toEqual([
      orderedIds[2],
      orderedIds[1],
      orderedIds[0],
    ]);
    expect(firstPage.hasMore).toBe(true);
  });
});
