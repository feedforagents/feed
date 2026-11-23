/** Preserve the signed prediction trade API totals. PRD §§9.1/9.2, MVP Phase 6. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const signedTrades = 'retains the exact signed fractional buy and sell amounts';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks prediction trade amounts on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'prediction-detail-trade-sign',
      file: 'packages/testing/integration/prediction-detail-trades-buy-amount-sign.integration.test.ts',
      cases: [signedTrades],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));

  const { PredictionDbAdapter, PredictionMarketService } = await import(
    '@feed/core/markets/prediction'
  );
  const { balanceTransactions, db, eq, positions, questions, users } =
    await import('@feed/db');
  const { createUserWalletAdapter } = await import(
    '@feed/engine/services/user-wallet-adapter'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/trades/route'
  );

  test(signedTrades, async () => {
    const userId = await generateSnowflakeId();
    const questionId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      username: `detail-trades-${userId}`,
      displayName: 'Prediction Trade Fixture',
      virtualBalance: '10000.00',
      updatedAt: new Date(),
    });
    const [question] = await db
      .insert(questions)
      .values({
        id: questionId,
        questionNumber: 1,
        text: 'Prediction trade fixture',
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 7 * 86400000),
        status: 'active',
        updatedAt: new Date(),
      })
      .returning();
    if (!question) throw new Error('Prediction trade question insert failed');
    const adapter = new PredictionDbAdapter();
    const market = await adapter.createMarketFromQuestion(
      { ...question, status: 'active' },
      10000,
      { initialYesProbability: 0.5 }
    );
    const service = new PredictionMarketService({
      db: adapter,
      wallet: createUserWalletAdapter(),
      fees: {
        tradingFeeRate: 0.001,
        platformShare: 0.7,
        referrerShare: 0.3,
        minFeeAmount: 0.01,
      },
    });
    await service.buy({
      marketId: market.id,
      userId,
      amount: 100.37,
      side: 'yes',
    });
    const [position] = await db
      .select({ id: positions.id, shares: positions.shares })
      .from(positions)
      .where(eq(positions.marketId, market.id));
    if (!position) throw new Error('Prediction trade buy returned no position');
    await service.sell({
      marketId: market.id,
      userId,
      positionId: position.id,
      shares: Number(position.shares),
    });

    const ledger = await db
      .select({
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
      })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.relatedId, market.id));
    const amounts = new Map(
      ledger.map((row) => [row.type, Number(row.amount)])
    );
    const buy = amounts.get('pred_buy');
    const sell = amounts.get('pred_sell');
    expect(buy).toBe(-100.37);
    expect(sell).toBeGreaterThan(0);
    expect(Number.isInteger(sell)).toBe(false);

    const response = await GET(
      new NextRequest(
        `http://127.0.0.1/api/markets/predictions/${market.id}/trades`
      ),
      { params: Promise.resolve({ id: market.id }) }
    );
    expect(response.status).toBe(200);
    const { trades, total } = (await response.json()) as {
      trades: Array<{ transactionType: string; amount: number }>;
      total: number;
    };
    expect(total).toBe(2);
    expect(trades).toHaveLength(2);
    expect(trades).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transactionType: 'pred_buy', amount: buy }),
        expect.objectContaining({ transactionType: 'pred_sell', amount: sell }),
      ])
    );
  });
}
