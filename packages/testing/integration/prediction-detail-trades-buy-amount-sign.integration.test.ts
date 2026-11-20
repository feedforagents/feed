/**
 * 네 줄 헤더
 * - 사용자 행동: 예측 마켓 상세(/markets/predictions/[id] → 터미널 Trades 탭)를
 *   열어 거래 내역의 Amount를 읽는다.
 * - 기대 근거: 코드베이스 자체 규칙 — 지갑 원장은 차감(debit)을 음수 delta로
 *   기록하는 장부 값이고(WalletService.debit: delta = -amount), 사람에게
 *   보여주는 금액은 크기로 정규화한다. 자매 라우트
 *   GET /api/users/[userId]/activity는 같은 pred_buy/pred_sell 원장 행을
 *   `amount: Math.abs(Number(trade.amount))`로 반환한다. 같은 목록 안의
 *   NPC 거래 행도 항상 양수 금액이다.
 * - 실제 손실: 상세 Trades 탭의 모든 매수 행이 "Bought prediction shares —
 *   Amount: -$100.00"처럼 음수로 뜬다. 매도 행은 순수익 양수(+$98.04)로
 *   뜨니 같은 Amount 칸에서 매수만 부호가 뒤집힌다. 매수 금액이 환불·손실처럼
 *   읽힌다.
 * - 가장 가까운 열린 PR 재현 결과: 중복 스윕 결과는 REPORT.md 참조.
 *   #1747(동점)·#1663(total)은 trades 라우트의 amount 매핑을 건드리지
 *   않는다.
 *
 * GET /api/markets/predictions/[id]/trades against a real database: the
 * Amount shown for a user trade in the market detail Trades tab must be
 * the magnitude of the money that moved — positive for both buys and
 * sells, with the direction carried by the "Bought"/"Sold" label. The
 * route instead returns the raw signed wallet-ledger delta, so every
 * pred_buy row (WalletService.debit stores delta = -amount) shows as a
 * negative amount while pred_sell rows (credit) and NPC rows show
 * positive. The sibling activity route already normalizes the same rows
 * with Math.abs; this route does not.
 *
 * Fixtures use the real trade path (PredictionMarketService wired to the
 * REAL WalletService), so each trade writes its real ledger row. The
 * trades route handler is called directly (no dev server). Ownership:
 * fixture ids are registered only from successful INSERT ... RETURNING
 * results. Teardown deletes only registered rows and reads back zero
 * remaining fixture rows.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

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
import { NextRequest } from 'next/server';

type TradeRow = {
  id: string;
  type: 'balance' | 'npc';
  transactionType?: string;
  amount: number;
  timestamp: string;
};
type TradesResponse = {
  trades: TradeRow[];
  total: number;
  hasMore: boolean;
};

let tradesGET: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/trades/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const userId = `w4b-user-${suffix}`;
const marketId = `w4b-market-${suffix}`;
const ownedUserIds: string[] = [];
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
let questionNumber = 1_880_000_000 + Math.floor(Math.random() * 100_000_000);
let service: PredictionMarketService;
let boughtShares = 0;

async function fetchTrades(): Promise<TradesResponse> {
  const response = await tradesGET(
    new NextRequest(
      `http://localhost/api/markets/predictions/${marketId}/trades?limit=20&offset=0`
    ),
    { params: Promise.resolve({ id: marketId }) }
  );
  return (await response.json()) as TradesResponse;
}

/** Raw signed ledger amount for one trade type, as the wallet stored it. */
async function ledgerAmount(type: 'pred_buy' | 'pred_sell'): Promise<number> {
  const rows = await db
    .select({ amount: balanceTransactions.amount })
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.relatedId, marketId),
        eq(balanceTransactions.type, type)
      )
    );
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one ${type} ledger row, got ${rows.length}`
    );
  }
  return Number(rows[0]?.amount);
}

beforeAll(async () => {
  ({ GET: tradesGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/trades/route'
  ));

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      username: `w4b-${suffix}`,
      displayName: 'Detail Trades Amount Fixture User',
      virtualBalance: '10000.00',
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error(`user insert failed for ${userId}`);
  ownedUserIds.push(user.id);

  const [question] = await db
    .insert(questions)
    .values({
      id: marketId,
      questionNumber: questionNumber++,
      text: `Detail trades amount fixture ${marketId}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 7 * 86400000),
      status: 'active',
      updatedAt: new Date(),
    })
    .returning();
  if (!question) throw new Error(`question insert failed for ${marketId}`);
  ownedQuestionIds.push(question.id);
  const existing = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, marketId));
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    10000,
    { initialYesProbability: 0.5 }
  );
  if (existing.length === 0) ownedMarketIds.push(market.id);

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

  // One real YES buy of $100, then a full sell of the position.
  await service.buy({ marketId, userId, amount: 100, side: 'yes' });
  const [position] = await db
    .select({ shares: positions.shares, id: positions.id })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  if (!position || Number(position.shares) <= 0) {
    throw new Error('fixture buy left no shares');
  }
  boughtShares = Number(position.shares);
  await service.sell({
    marketId,
    userId,
    shares: boughtShares,
    positionId: position.id,
  });
});

afterAll(async () => {
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
});

describe('prediction detail trades amounts', () => {
  it('shows the buy amount as the positive amount paid, not the signed ledger delta', async () => {
    // Mechanism, read from the ledger itself: the debit row stores -100.
    expect(await ledgerAmount('pred_buy')).toBe(-100);
    const { trades } = await fetchTrades();
    const buy = trades.find((t) => t.transactionType === 'pred_buy');
    expect(buy).toBeDefined();
    expect(buy?.amount).toBe(100);
  });

  it('shows the sell amount positive, with the same sign as the buy', async () => {
    // The credit row is already positive in the ledger.
    expect(await ledgerAmount('pred_sell')).toBeGreaterThan(0);
    const { trades } = await fetchTrades();
    const buy = trades.find((t) => t.transactionType === 'pred_buy');
    const sell = trades.find((t) => t.transactionType === 'pred_sell');
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(sell?.amount).toBeGreaterThan(0);
    // One Amount column: buys and sells must not carry opposite signs.
    expect(Math.sign(buy?.amount ?? 0)).toBe(Math.sign(sell?.amount ?? 0));
    expect(
      trades.filter((t) => t.type === 'balance').every((t) => t.amount >= 0)
    ).toBe(true);
  });
});
