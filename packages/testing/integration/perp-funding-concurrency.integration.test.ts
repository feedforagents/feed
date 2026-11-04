import { afterAll, describe, expect, it } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const owners: string[] = [];
const tickers: string[] = [];
const fees = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

// Pause only after the real database snapshot; the close uses its own real
// transaction and wallet. No lock or database behavior is simulated.
class FundingSnapshotDb extends PerpDbAdapter {
  afterSnapshot?: () => Promise<void>;

  constructor(private readonly ticker: string) {
    super();
  }

  async listMarkets() {
    return (await super.listMarkets()).filter((m) => m.ticker === this.ticker);
  }

  async listOpenPositions() {
    const rows = (await super.listOpenPositions()).filter(
      (p) => p.ticker === this.ticker
    );
    await this.afterSnapshot?.();
    return rows;
  }
}

async function fixture(longSize = 200, shortSize = 100, fundingPaid = 10) {
  const userIds = [await generateSnowflakeId(), await generateSnowflakeId()];
  const positionIds = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const ticker = `FC${userIds[0]}`;
  owners.push(...userIds);
  tickers.push(ticker);
  await dbWrite.transaction(async (tx) => {
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
      markPrice: 100,
      indexPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: longSize + shortSize,
      bidDepth: 1000000,
      askDepth: 1000000,
      maxLeverage: 20,
      minOrderSize: 10,
      fundingRate: {
        ticker,
        rate: 0,
        predictedRate: 0,
        nextFundingTime: new Date().toISOString(),
      },
    });
    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i]!;
      const positionId = positionIds[i]!;
      const size = i === 0 ? longSize : shortSize;
      await tx.insert(users).values({
        id: userId,
        username: `funding-lock-${userId}`,
        virtualBalance: '1000',
        totalDeposited: '1000',
        profileComplete: true,
        updatedAt: new Date(),
      });
      await tx.insert(perpPositions).values({
        id: positionId,
        userId,
        ticker,
        organizationId: ticker,
        side: i === 0 ? 'long' : 'short',
        entryPrice: 100,
        currentPrice: 100,
        size,
        leverage: 10,
        liquidationPrice: i === 0 ? 90 : 110,
        fundingPaid: i === 0 ? fundingPaid : -fundingPaid / 2,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        lastUpdated: new Date(),
      });
      await createUserWalletAdapter(tx).debit({
        userId,
        amount: size / 10,
        reason: 'perp_open',
        relatedId: positionId,
      });
    }
  });
  const adapter = new FundingSnapshotDb(ticker);
  const service = new PerpMarketService({
    db: adapter,
    wallet: createUserWalletAdapter(),
    settlement: createPerpSettlement(),
    fees,
  });
  return { userIds, positionIds, ticker, adapter, service };
}

afterAll(async () => {
  if (owners.length) {
    await dbWrite
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, owners));
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, owners));
    await dbWrite.delete(users).where(inArray(users.id, owners));
  }
  if (tickers.length) {
    await dbWrite
      .delete(perpMarketSnapshots)
      .where(inArray(perpMarketSnapshots.ticker, tickers));
    await dbWrite
      .delete(organizationState)
      .where(inArray(organizationState.id, tickers));
  }
});

describe('funding accrual against real Postgres closes', () => {
  for (const percentage of [0.5, 1]) {
    it(`rereads the position after a ${percentage * 100}% close commits mid-step`, async () => {
      const f = await fixture();
      f.adapter.afterSnapshot = async () => {
        await f.service.closePosition({
          userId: f.userIds[0]!,
          positionId: f.positionIds[0]!,
          percentage,
        });
      };
      await f.service.processFundingStep();
      const [position] = await dbWrite
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, f.positionIds[0]!));
      const ledger = await dbWrite
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, f.userIds[0]!));
      expect(ledger.filter((entry) => entry.type === 'perp_open')).toHaveLength(
        1
      );
      expect(
        ledger.filter((entry) =>
          ['perp_close', 'perp_partial_close'].includes(entry.type)
        )
      ).toHaveLength(1);
      if (percentage === 1) {
        expect(position!.closedAt).not.toBeNull();
        expect(position!.fundingPaid).toBe(10);
      } else {
        // The original 2:1 interest snapshot fixes this step's rate. Only the
        // fresh size, side and previously unsettled funding come from the lock.
        const annualRate = 0.01 + (0.5 - 0.01) * (1 / 3) ** 3;
        const periodRate = annualRate / ((365.25 * 24) / 8);
        expect(position!.closedAt).toBeNull();
        expect(position!.size).toBe(100);
        expect(position!.fundingPaid).toBeCloseTo(5 + 100 * periodRate, 10);
      }
    });
  }
});

describe('funding sign on near-balanced books with real Postgres', () => {
  for (const [longSize, shortSize, direction] of [
    [100, 101, -1],
    [101, 100, 1],
  ] as const) {
    it(`stores a ${direction > 0 ? 'positive' : 'negative'} premium for ${longSize} long / ${shortSize} short`, async () => {
      const f = await fixture(longSize, shortSize, 0);
      await f.service.processFundingStep();
      await f.service.applyPriceUpdates({ [f.ticker]: 100 });
      const [market] = await dbWrite
        .select()
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, f.ticker));
      const positions = await f.adapter.listOpenPositions();
      const balances = await dbWrite
        .select({ balance: users.virtualBalance })
        .from(users)
        .where(inArray(users.id, f.userIds));
      expect(market!.fundingRate.rate).toBe(direction * 0.01);
      expect(market!.fundingRate.predictedRate).toBe(direction * 0.01);
      expect(Math.sign(market!.markPrice! - 100)).toBe(direction);
      // This book remains within the existing 5% no-payment band. The rate
      // and mark change direction without charging either position.
      expect(positions).toHaveLength(2);
      expect(positions.every((p) => p.fundingPaid === 0)).toBe(true);
      expect(
        balances.map((b) => Number(b.balance)).sort((a, b) => a - b)
      ).toEqual([1000 - 101 / 10, 1000 - 100 / 10]);
    });
  }
});
