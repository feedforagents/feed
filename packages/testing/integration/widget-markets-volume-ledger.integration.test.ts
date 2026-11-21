/**
 * 네 줄 헤더
 * - 사용자 행동: 마켓 위젯에서 거래량(Vol) 숫자를 본다.
 * - 기대 근거: SYMBaiEX의 #1801 닫힘 코멘트 ("The widget still has a valid
 *   defect: its volume field comes from pool balances. A smaller replacement
 *   can address that defect using an approved volume definition and keep the
 *   existing funding migration lineage intact.") + 어드민 통계 선례
 *   (admin/stats/trading: 거래량 = SUM(ABS(BalanceTransaction.amount)),
 *   type pred_buy/pred_sell).
 * - 실제 손실: 위젯 Vol이 거래된 돈이 아니라 풀 잔량(yesShares + noShares)
 *   이라, 거래 0건인 시드 마켓이 "Vol 10,000"으로 뜨고 거래량으로 오해됨.
 * - 가장 가까운 열린 PR 재현 결과: 닫힌 #1801 헤드(deae4cf9)에서는 새 원장
 *   테이블 + 0006 마이그레이션으로 고쳤으나 staging 0006과 충돌해 미병합
 *   종료됨. 이 슬롯의 대체안은 마이그레이션·새 테이블 없이 지갑 원장에서
 *   읽기 시점에 집계함. 열린 피드 PR 중 위젯 volume을 고치는 건 없음
 *   (중복 스윕 결과는 REPORT.md 참조).
 *
 * GET /api/feed/widgets/markets against a real database: the "Vol" number
 * the sidebar widget prints under a market must be the market's traded
 * volume — the all-time sum of ABS(amount) over the wallet ledger
 * (BalanceTransaction 'pred_buy' / 'pred_sell' with relatedId = market id),
 * the same aggregate the admin trading stats route already reports as
 * volume. No new table, no migration: every user prediction trade already
 * writes exactly one such ledger row (WalletService.debit 'pred_buy' on buy,
 * WalletService.credit 'pred_sell' on sell, market id in relatedId).
 *
 * The widget route instead reported the pool's current share balances
 * (yesShares + noShares), so a freshly seeded market with zero trades
 * showed "Vol 10,000" (its seed liquidity) and the figure moved with pool
 * balances rather than with trading activity. Summing the current positions
 * (shares x avgPrice) is not a fix either: the real sell path reduces
 * position shares on a partial sell and zeroes them on a full close, so
 * additional trading can reduce that figure and a completed buy/sell
 * roundtrip contributes zero.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and real trades through
 * PredictionMarketService wired to the REAL WalletService (thin adapter),
 * so each buy/sell writes its real ledger row. The expected volume is read
 * from the wallet ledger itself. All trades happen in beforeAll: the
 * anonymous widget response is cached for five minutes, so a trade placed
 * after the first fetch would not be visible to later fetches; the cache
 * is invalidated once in beforeAll after the trades.
 *
 * Ownership: fixture ids are registered only from successful INSERT ...
 * RETURNING results (and, for markets, only when the adapter's insert
 * actually created the row — on conflict it returns the pre-existing
 * market, which this fixture does not own). Teardown deletes only
 * registered rows, including the derived PredictionTrade and
 * PredictionPriceHistory rows a real trade leaves behind, and reads back
 * zero remaining fixture rows.
 *
 * Known approximation (same as the closed #1801 backfill): the ledger
 * records the settled cash amount — a buy is gross, fee included; a sell
 * is net proceeds, fee excluded — while a live trade records shares x
 * avgPrice, fee excluded. NPC trades have no BalanceTransaction rows and
 * are not covered. This matches the admin stats route's volume
 * definition, which is the precedent this replacement relies on.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { CACHE_KEYS, invalidateCache } from '@feed/api';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  questions,
  users,
} from '@feed/db';
import { WalletService } from '@feed/engine/services/wallet-service';
import { and } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type WidgetMarket = {
  id: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
};
type WidgetResponse = { success: boolean; markets: WidgetMarket[] };

let widgetGET: typeof import('../../../apps/web/src/app/api/feed/widgets/markets/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const userId = `wvl-user-${suffix}`;
const idleId = `wvl-idle-${suffix}`;
const tradedId = `wvl-traded-${suffix}`;
const partialId = `wvl-partial-${suffix}`;
const closedId = `wvl-closed-${suffix}`;
// Ownership is registered only from successful INSERT … RETURNING results.
const ownedUserIds: string[] = [];
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
let questionNumber = 1_860_000_000 + Math.floor(Math.random() * 100_000_000);
let service: PredictionMarketService;

async function fetchWidget(token?: string) {
  const response = await widgetGET(
    new NextRequest('http://localhost/api/feed/widgets/markets', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  );
  return (await response.json()) as WidgetResponse;
}

/** Traded volume exactly as the route defines it: all-time Σ ABS(amount) over the wallet ledger. */
async function ledgerVolume(marketId: string): Promise<number> {
  const rows = await db
    .select({ amount: balanceTransactions.amount })
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.relatedId, marketId),
        inArray(balanceTransactions.type, ['pred_buy', 'pred_sell'])
      )
    );
  return rows.reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0);
}

async function positionShares(marketId: string): Promise<number> {
  const rows = await db
    .select({ shares: positions.shares })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  return rows.reduce((sum, p) => sum + Number(p.shares), 0);
}

async function createMarket(id: string): Promise<void> {
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: questionNumber++,
      text: `Widget volume ledger fixture ${id}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 7 * 86400000),
      status: 'active',
      updatedAt: new Date(),
    })
    .returning();
  if (!question) throw new Error(`question insert failed for ${id}`);
  ownedQuestionIds.push(question.id);
  const existing = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, id));
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    10000,
    { initialYesProbability: 0.5 }
  );
  // The adapter returns an existing market after an insert conflict; only
  // a market this fixture actually inserted is owned.
  if (existing.length === 0) ownedMarketIds.push(market.id);
}

async function buyYes(marketId: string, amount: number): Promise<void> {
  await service.buy({ marketId, userId, amount, side: 'yes' });
}

async function sellYes(marketId: string, shares: number): Promise<void> {
  const position = await new PredictionDbAdapter().getPosition(
    userId,
    marketId,
    'yes'
  );
  if (!position) throw new Error(`no YES position for ${marketId}`);
  await service.sell({ marketId, userId, shares, positionId: position.id });
}

beforeAll(async () => {
  ({ GET: widgetGET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/markets/route'
  ));

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      username: `wvl-${suffix}`,
      displayName: 'Widget Volume Ledger Fixture User',
      virtualBalance: '10000.00',
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error(`user insert failed for ${userId}`);
  ownedUserIds.push(user.id);

  // Idle market: seeded with liquidity, never traded.
  await createMarket(idleId);
  // Traded market: seeded the same way, then one real YES buy.
  await createMarket(tradedId);
  // Partial-sell market: one buy, then half the position sold.
  await createMarket(partialId);
  // Full-close market: one buy, then the whole position sold.
  await createMarket(closedId);

  // Real wallet: each buy/sell writes its real BalanceTransaction row
  // (pred_buy / pred_sell, market id in relatedId). No fee processor:
  // the fee is folded into the shares calculation, so one trade writes
  // exactly one ledger row. A trade without a market relatedId would
  // silently drop out of the volume aggregate, so refuse it loudly.
  function mustRelatedId(value: string | undefined, label: string): string {
    if (!value) throw new Error(`${label} called without a market relatedId`);
    return value;
  }
  service = new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async (args) =>
        WalletService.debit(
          args.userId,
          args.amount,
          args.reason,
          args.description ?? '',
          mustRelatedId(args.relatedId, 'wallet debit')
        ),
      credit: async (args) =>
        WalletService.credit(
          args.userId,
          args.amount,
          args.reason,
          args.description ?? '',
          mustRelatedId(args.relatedId, 'wallet credit')
        ),
      recordPnL: async (args) => {
        await WalletService.recordPnL(
          args.userId,
          args.pnl,
          args.reason,
          args.relatedId
        );
      },
      getBalance: async (userIdArg: string) =>
        WalletService.getBalance(userIdArg),
    },
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.7,
      referrerShare: 0.3,
      minFeeAmount: 0.01,
    },
  });

  await buyYes(tradedId, 1000);

  await buyYes(partialId, 1000);
  const partialBought = await positionShares(partialId);
  if (partialBought <= 0) throw new Error('partial fixture buy left no shares');
  await sellYes(partialId, partialBought / 2);

  await buyYes(closedId, 1000);
  const closedBought = await positionShares(closedId);
  if (closedBought <= 0) throw new Error('closed fixture buy left no shares');
  await sellYes(closedId, closedBought);

  // The first widget case must read a fresh list even if this file
  // runs twice in one process: the widget cache is five minutes.
  await invalidateCache('markets-widget-v3', { namespace: CACHE_KEYS.WIDGET });
});

afterAll(async () => {
  // Delete owned derived rows first, then the owned rows themselves.
  // No catch-all: a failed cleanup must fail the run, not hide a leak.
  // (No PredictionTrade rows: that table only exists in the closed #1801,
  // not on staging base.)
  await db
    .delete(predictionPriceHistories)
    .where(inArray(predictionPriceHistories.marketId, ownedMarketIds));
  await db.delete(positions).where(inArray(positions.marketId, ownedMarketIds));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.relatedId, ownedMarketIds));
  await db.delete(markets).where(inArray(markets.id, ownedMarketIds));
  await db.delete(questions).where(inArray(questions.id, ownedQuestionIds));
  await db.delete(users).where(inArray(users.id, ownedUserIds));

  // Residue readback: nothing owned may survive the run.
  const [
    historyRows,
    positionRows,
    ledgerRows,
    marketRows,
    questionRows,
    userRows,
  ] = await Promise.all([
    db
      .select()
      .from(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, ownedMarketIds)),
    db
      .select()
      .from(positions)
      .where(inArray(positions.marketId, ownedMarketIds)),
    db
      .select()
      .from(balanceTransactions)
      .where(inArray(balanceTransactions.relatedId, ownedMarketIds)),
    db.select().from(markets).where(inArray(markets.id, ownedMarketIds)),
    db.select().from(questions).where(inArray(questions.id, ownedQuestionIds)),
    db.select().from(users).where(inArray(users.id, ownedUserIds)),
  ]);
  expect(historyRows).toHaveLength(0);
  expect(positionRows).toHaveLength(0);
  expect(ledgerRows).toHaveLength(0);
  expect(marketRows).toHaveLength(0);
  expect(questionRows).toHaveLength(0);
  expect(userRows).toHaveLength(0);

  await invalidateCache('markets-widget-v3', { namespace: CACHE_KEYS.WIDGET });
});

describe('markets widget volume from the wallet ledger', () => {
  it('shows zero volume for a seeded market with no trades', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === idleId);
    expect(row).toBeDefined();
    expect(await ledgerVolume(idleId)).toBe(0);
    expect(row?.volume).toBe(0);
  });

  it('shows the traded volume from the wallet ledger after a real trade', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === tradedId);
    expect(row).toBeDefined();
    const expected = await ledgerVolume(tradedId);
    expect(expected).toBe(1000);
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
  });

  it('keeps volume after a partial sell — the sell adds to the ledger', async () => {
    // The position was halved by the sell, so a positions-based sum would
    // report roughly half the buy alone; the ledger holds buy + sell.
    const remaining = await positionShares(partialId);
    const boughtAll = await ledgerVolume(partialId);
    expect(remaining).toBeGreaterThan(0);
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === partialId);
    expect(row).toBeDefined();
    expect(boughtAll).toBeGreaterThan(1000);
    expect(row?.volume ?? -1).toBeCloseTo(boughtAll, 6);
  });

  it('keeps volume after a full close, when no position remains', async () => {
    // The old positions-based definition reported zero here.
    expect(await positionShares(closedId)).toBe(0);
    const expected = await ledgerVolume(closedId);
    expect(expected).toBeGreaterThan(0);
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === closedId);
    expect(row).toBeDefined();
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
    expect(row?.volume ?? 0).toBeGreaterThan(0);
  });

  it('ranks the fully closed market above the idle one — the sort consumes the same volume', async () => {
    const widget = await fetchWidget();
    const ids = widget.markets.map((m) => m.id);
    const closedIndex = ids.indexOf(closedId);
    const idleIndex = ids.indexOf(idleId);
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    expect(closedIndex).toBeLessThan(idleIndex);
  });

  it('reports the same ledger volume on the authenticated read', async () => {
    // The authenticated branch (asUser) reads through the same helper;
    // prove it with a real Steward token for the fixture user.
    const token = await new SignJWT({ userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(
        new TextEncoder().encode(
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
        )
      );
    await invalidateCache('markets-widget-v3', {
      namespace: CACHE_KEYS.WIDGET,
    });
    const widget = await fetchWidget(token);
    const row = widget.markets.find((m) => m.id === tradedId);
    expect(row).toBeDefined();
    expect(row?.volume ?? -1).toBeCloseTo(await ledgerVolume(tradedId), 6);
  });
});
