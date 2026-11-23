/** PRD §§9.1 and 9.3 / MVP Phase 6: settle the close and wallet credit atomically. */
import { afterAll, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const creditFailureCase =
  'rolls back an ordinary perp partial close when wallet credit fails and settles it once on retry';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks perp close credit rollback in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'perp-close-credit-rollback',
      file: 'packages/testing/integration/perp-close-settlement-atomic.integration.test.ts',
      cases: [creditFailureCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { PerpDbAdapter, PerpMarketService } = await import(
    '@feed/core/markets/perps'
  );
  const {
    and,
    balanceTransactions,
    closeDatabase,
    dbWrite,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    users,
  } = await import('@feed/db');
  const { createPerpSettlement, createUserWalletAdapter, FEE_CONFIG } =
    await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');

  type Wallet = ReturnType<typeof createUserWalletAdapter>;

  afterAll(async () => {
    await closeDatabase();
  });

  test(creditFailureCase, async () => {
    const userId = await generateSnowflakeId();
    const ticker = `CLOSEATOM${userId}`;
    const now = new Date();
    const reason = 'perp_partial_close';
    const creditAttempts: number[] = [];

    // Fault only the positive close credit, before delegating to the real wallet.
    // Wrap both ports so the regression detects a move back outside settlement.
    const withCreditFault = (real: Wallet): Wallet => ({
      ...real,
      async credit(params) {
        if (params.reason === reason) {
          creditAttempts.push(params.amount);
          if (creditAttempts.length === 1)
            throw new Error('Owned wallet outage');
        }
        return real.credit(params);
      },
    });

    await dbWrite.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `close-atom-${userId}`,
        virtualBalance: '10000',
        totalDeposited: '10000',
        lifetimePnL: '0',
        updatedAt: now,
      });
      await tx.insert(organizationState).values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: now,
      });
      await tx.insert(perpMarketSnapshots).values({
        ticker,
        organizationId: ticker,
        currentPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 0,
        volume24h: 0,
        metrics24hResetAt: now,
        fundingRate: {
          ticker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: now.toISOString(),
        },
      });
    });
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: withCreditFault(createUserWalletAdapter()),
      settlement: createPerpSettlement({
        wallet: (_owner, tx, afterCommit) =>
          withCreditFault(createUserWalletAdapter(tx, afterCommit)),
      }),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
    const opened = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    });

    async function readState() {
      const [[position], [owner], [market], credits] = await Promise.all([
        dbWrite
          .select({
            size: perpPositions.size,
            leverage: perpPositions.leverage,
            closedAt: perpPositions.closedAt,
            realizedPnL: perpPositions.realizedPnL,
            fundingPaid: perpPositions.fundingPaid,
          })
          .from(perpPositions)
          .where(eq(perpPositions.id, opened.positionId)),
        dbWrite
          .select({
            balance: users.virtualBalance,
            lifetimePnL: users.lifetimePnL,
          })
          .from(users)
          .where(eq(users.id, userId)),
        dbWrite
          .select({
            openInterest: perpMarketSnapshots.openInterest,
            volume24h: perpMarketSnapshots.volume24h,
          })
          .from(perpMarketSnapshots)
          .where(eq(perpMarketSnapshots.ticker, ticker)),
        dbWrite
          .select({
            amount: balanceTransactions.amount,
            relatedId: balanceTransactions.relatedId,
          })
          .from(balanceTransactions)
          .where(
            and(
              eq(balanceTransactions.userId, userId),
              eq(balanceTransactions.type, reason)
            )
          ),
      ] as const);
      if (!position || !owner || !market) {
        throw new Error('Missing leased close fixture state');
      }
      return { position, owner, market, credits };
    }

    const before = await readState();
    expect(before.credits).toHaveLength(0);
    const close = () =>
      service.closePosition({
        userId,
        positionId: opened.positionId,
        percentage: 0.5,
      });

    await expect(close()).rejects.toThrow('Owned wallet outage');
    expect(creditAttempts).toHaveLength(1);
    expect(creditAttempts[0]).toBeGreaterThan(0);
    expect(await readState()).toEqual(before);

    const result = await close();
    const after = await readState();
    const [credit] = after.credits;
    if (!credit) throw new Error('Retry did not persist its wallet credit');
    expect(after.credits).toHaveLength(1);
    const amount = Number(credit.amount);
    const closedSize = before.position.size / 2;
    const releasedMargin = closedSize / before.position.leverage;
    expect(creditAttempts).toEqual([amount, amount]);
    expect(credit.relatedId).toBe(opened.positionId);
    expect(result.fullyClosed).toBe(false);
    expect(after.position.closedAt).toBeNull();
    expect(after.position.size).toBe(closedSize);
    expect(after.market.openInterest).toBe(
      before.market.openInterest - closedSize
    );
    expect(after.market.volume24h).toBe(before.market.volume24h + closedSize);
    expect(result.balance).toBe(Number(after.owner.balance));
    expect(Number(after.owner.balance)).toBeCloseTo(
      Number(before.owner.balance) + amount,
      8
    );
    expect(Number(after.owner.lifetimePnL)).toBeCloseTo(
      Number(before.owner.lifetimePnL) + amount - releasedMargin,
      8
    );
  });
}
