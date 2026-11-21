/**
 * PRD §9.1 (Trading fee) / MVP Phase 6: an opposite-side order that reduces a
 * perp position pays the canonical fee on the ordered size. Execution, the
 * preview, the wallet and the fee ledger (TradingFee row and
 * users.totalFeesPaid) agree. The case runs in a positively leased fresh
 * database; the lease owns all cleanup. Only the server-only marker is
 * stubbed; the routes, fee service and database run for real.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedPerpReduceFeeCases,
  verifyPerpReduceFeeChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_PERP_REDUCE_FEE_CHILD) {
  test('runs the perp reduce fee case in a leased fresh database', async () => {
    await runIsolatedPerpReduceFeeCases();
  }, 300_000);
} else {
  // No application client may be imported before positive child ownership.
  await verifyPerpReduceFeeChildLease();
  mock.module('server-only', () => ({}));
  const {
    balanceTransactions,
    closeDatabase,
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    tradingFees,
    users,
  } = await import('@feed/db');
  const { NextRequest } = await import('next/server');
  const { POST: openRoute } = await import(
    '../../../apps/web/src/app/api/markets/perps/open/route'
  );
  const { POST: previewRoute } = await import(
    '../../../apps/web/src/app/api/markets/perps/preview/route'
  );
  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  const START_BALANCE = 10_000;

  async function post(
    route: (request: InstanceType<typeof NextRequest>) => Promise<Response>,
    path: string,
    userId: string,
    body: Record<string, unknown>
  ) {
    const previous = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      const response = await route(
        new NextRequest(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '198.19.0.1',
            authorization: `Bearer steward:test:${userId}`,
          },
          body: JSON.stringify(body),
        })
      );
      const json = await response.json();
      expect(response.status, JSON.stringify(json)).toBeLessThan(300);
      return json;
    } finally {
      if (previous === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previous;
    }
  }

  test('reduce through the open route charges and records the canonical fee on the ordered size', async () => {
    const userId = `reduce-fee-${crypto.randomUUID()}`;
    const ticker = 'REDUCEFEE';
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: userId,
        virtualBalance: String(START_BALANCE),
        totalDeposited: String(START_BALANCE),
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
      await tx.insert(organizationState).values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: new Date(),
      });
      await tx.insert(perpMarketSnapshots).values({
        ticker,
        organizationId: ticker,
        currentPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 0,
        volume24h: 0,
        fundingRate: {
          ticker,
          rate: 0,
          nextFundingTime: new Date().toISOString(),
          predictedRate: 0,
        },
      });
    });

    const opened = await post(openRoute, '/api/markets/perps/open', userId, {
      ticker,
      side: 'long',
      size: 116,
      leverage: 1,
      orderType: 'market',
    });

    const order = { ticker, side: 'short', size: 30.01, leverage: 1 };
    const { preview } = await post(
      previewRoute,
      '/api/markets/perps/preview',
      userId,
      order
    );
    expect(preview.rebalanceType).toBe('reduce');

    // 116 * (30.01 / 116) is 30.009999999999998: settling that size floors
    // to 30.00 and charges 0.03, not the canonical fee on 30.01.
    const reduced = await post(openRoute, '/api/markets/perps/open', userId, {
      ...order,
      orderType: 'market',
    });
    expect(reduced.position.rebalanceType).toBe('reduce');
    expect(reduced.fee.amount).toBe(0.04);
    expect(reduced.fee.amount).toBe(preview.estimatedFee);

    // Fee ledger: the recorded close fee and the trader total match the charge.
    const closeFees = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.tradeType, 'perp_close'));
    expect(closeFees.map((row) => Number(row.feeAmount))).toEqual([
      reduced.fee.amount,
    ]);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(user?.totalFeesPaid)).toBeCloseTo(
      opened.fee.amount + reduced.fee.amount,
      9
    );

    // Wallet: the stored balance is the one the route reported, and the
    // balance ledger accounts for every point that moved.
    expect(Number(user?.virtualBalance)).toBeCloseTo(reduced.newBalance, 9);
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const ledgerNet = ledger.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(ledgerNet).toBeCloseTo(
      Number(user?.virtualBalance) - START_BALANCE,
      9
    );

    const [position] = await db
      .select({ size: perpPositions.size })
      .from(perpPositions)
      .where(eq(perpPositions.id, opened.position.positionId));
    expect(Number(position?.size)).toBeCloseTo(85.99, 9);
  });
}
