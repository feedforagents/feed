/**
 * PRD §§8.1 and 9.3 (D-17b), MVP Phases 3 and 6: agent tools apply the same
 * rules as REST. The HTTP open route (PerpOpenPositionSchema) and MCP
 * open_position accept whole-number leverage from 1x to 20x only;
 * A2A markets.open_position must reject the same inputs before trading.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

const userIds: string[] = [];
const tickers: string[] = [];

async function fixture() {
  const userId = await generateSnowflakeId();
  const ticker = `AL${userId}`;
  const time = new Date();
  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username: `a2a-lev-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      profileComplete: true,
      updatedAt: time,
    });
    await tx.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: time,
    });
    await tx.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: ticker,
      currentPrice: 100,
      markPrice: 100,
      indexPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 1_000_000,
      bidDepth: 1_000_000,
      askDepth: 1_000_000,
      maxLeverage: 20,
      minOrderSize: 10,
      fundingRate: {
        ticker,
        rate: 0,
        predictedRate: 0,
        nextFundingTime: time.toISOString(),
      },
    });
  });
  userIds.push(userId);
  tickers.push(ticker);
  return { userId, ticker };
}

async function state(userId: string) {
  const [positions, [wallet], ledger, fees] = await Promise.all([
    dbWrite
      .select({ size: perpPositions.size, leverage: perpPositions.leverage })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId)),
    dbWrite
      .select({ balance: users.virtualBalance })
      .from(users)
      .where(eq(users.id, userId)),
    dbWrite
      .select({ id: balanceTransactions.id })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId)),
    dbWrite
      .select({ id: tradingFees.id })
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId)),
  ] as const);
  if (!wallet) throw new Error('The fixture wallet is missing');
  return { positions, balance: Number(wallet.balance), ledger, fees };
}

function open(userId: string, ticker: string, leverage: number) {
  return FeedAgentExecutor.executeDirectly(
    'markets.open_position',
    { ticker, side: 'long', amount: 100, leverage },
    userId
  );
}

afterAll(async () => {
  await dbWrite.delete(tradingFees).where(inArray(tradingFees.userId, userIds));
  await dbWrite
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, userIds));
  await dbWrite
    .delete(perpPositions)
    .where(inArray(perpPositions.userId, userIds));
  await dbWrite
    .delete(perpMarketSnapshots)
    .where(inArray(perpMarketSnapshots.ticker, tickers));
  await dbWrite
    .delete(organizationState)
    .where(inArray(organizationState.id, tickers));
  await dbWrite.delete(users).where(inArray(users.id, userIds));
});

describe('A2A markets.open_position leverage', () => {
  for (const leverage of [2.5, 1.4, 21, 50]) {
    it(`rejects ${leverage}x before persisting a trade`, async () => {
      const f = await fixture();
      const before = await state(f.userId);

      const error = await open(f.userId, f.ticker, leverage).then(
        () => null,
        (e: Error) => e
      );

      expect(error?.message).toMatch(/leverage/i);
      expect(error?.message).not.toMatch(/Failed query|PerpPosition|params:/i);
      expect(await state(f.userId)).toEqual(before);
    });
  }

  it('persists a position at a whole-number leverage', async () => {
    const f = await fixture();

    const result = await open(f.userId, f.ticker, 2);

    expect(result).toMatchObject({
      success: true,
      position: { ticker: f.ticker, side: 'LONG', size: 100, leverage: 2 },
    });
    const after = await state(f.userId);
    expect(after.positions).toEqual([{ size: 100, leverage: 2 }]);
    expect(after.fees).toHaveLength(1);
  });
});
