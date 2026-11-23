/** PRD §9.2 / MVP Phase 6: markets close to trading at their deadline. */
import { afterAll, expect, mock, setSystemTime, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const expiryCase =
  'fills the five-card list with markets strictly before close';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks New Markets expiry in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'new-markets-expiry',
      file: 'packages/testing/integration/new-markets-expiry.integration.test.ts',
      cases: [expiryCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { PredictionDbAdapter, PredictionMarketService } = await import(
    '@feed/core/markets/prediction'
  );
  const { closeDatabase, db, markets, questions } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/feed/new-markets/route'
  );
  type NewMarketsResponse =
    import('../../../apps/web/src/app/api/feed/new-markets/route').NewMarketsResponse;
  afterAll(async () => {
    await closeDatabase();
  });

  test(expiryCase, async () => {
    const now = new Date('2035-01-01T12:00:00.000Z');
    setSystemTime(now);
    try {
      const fixtures = await Promise.all(
        [-1, 0, 1, 60_000, 60_000, 60_000, 60_000, 60_000].map(
          async (offset, index) => ({
            marketId: await generateSnowflakeId(),
            questionId: await generateSnowflakeId(),
            questionNumber: 910_000 + index,
            createdAt: new Date(now.getTime() - (index + 1) * 60_000),
            deadline: new Date(now.getTime() + offset),
          })
        )
      );
      // Both closed rows are newer than all six open rows, so filtering
      // after taking five cards would leave the feed short.
      await db.transaction(async (tx) => {
        await tx.insert(markets).values(
          fixtures.map(({ marketId, createdAt, deadline }) => ({
            id: marketId,
            question: 'New Markets expiry fixture',
            yesShares: '100',
            noShares: '100',
            liquidity: '1000',
            resolved: false,
            endDate: deadline,
            createdAt,
            updatedAt: createdAt,
          }))
        );
        await tx.insert(questions).values(
          fixtures.map(
            ({
              marketId,
              questionId,
              questionNumber,
              createdAt,
              deadline,
            }) => ({
              id: questionId,
              marketId,
              questionNumber,
              text: 'New Markets expiry fixture',
              scenarioId: 1,
              outcome: true,
              rank: 1,
              resolutionDate: deadline,
              status: 'active',
              createdAt,
              updatedAt: createdAt,
            })
          )
        );
      });
      const atClose = fixtures[1];
      if (!atClose) throw new Error('Missing the exact-close fixture');
      const unexpectedWalletCall = async () => {
        throw new Error('The expiry guard must run before any wallet call');
      };
      const service = new PredictionMarketService({
        db: new PredictionDbAdapter(),
        wallet: {
          debit: unexpectedWalletCall,
          credit: unexpectedWalletCall,
          recordPnL: unexpectedWalletCall,
          getBalance: unexpectedWalletCall,
        },
        fees: {
          tradingFeeRate: 0,
          platformShare: 0,
          referrerShare: 0,
          minFeeAmount: 0,
        },
      });
      await expect(
        service.buy({
          marketId: atClose.marketId,
          userId: 'new-markets-expiry-fixture',
          side: 'yes',
          amount: 10,
        })
      ).rejects.toThrow('Market expired');

      const response = await GET(
        new NextRequest('http://localhost/api/feed/new-markets')
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as NewMarketsResponse;
      expect(result.markets.map(({ marketId }) => marketId)).toEqual(
        fixtures.slice(2, 7).map(({ marketId }) => marketId)
      );
    } finally {
      setSystemTime();
    }
  });
}
