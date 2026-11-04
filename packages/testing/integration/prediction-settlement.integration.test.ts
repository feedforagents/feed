import { afterAll, describe, expect, it } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  sql,
  tradingFees,
  users,
} from '@feed/db';
import {
  createUserWalletAdapter,
  FEE_CONFIG,
  FeeService,
  type FeeType,
  type PredictionSettlementOptions,
  withPredictionSettlement,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import {
  executeBuyShares as buyShares,
  executeSellShares,
} from '../../mcp/src/handlers/tool-handlers';
import type {
  AuthenticatedAgent,
  BuySharesArgs,
} from '../../mcp/src/types/mcp';

const options: PredictionSettlementOptions = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
  feeProcessor: (tx) => ({
    processTradingFee: ({ userId, type, amount, positionId, relatedId }) =>
      FeeService.processTradingFee(
        userId,
        type as FeeType,
        amount,
        positionId,
        relatedId,
        tx
      ),
  }),
};
const userIds: string[] = [];
const marketIds: string[] = [];

const positionSchema = z.object({
  id: z.string(),
  shares: z.number().finite().positive(),
});

async function executeBuyShares(
  agent: AuthenticatedAgent,
  args: BuySharesArgs
) {
  const result = await buyShares(agent, args);
  return { ...result, position: positionSchema.parse(result.position) };
}

async function fixture() {
  const userId = await generateSnowflakeId();
  const marketId = await generateSnowflakeId();
  userIds.push(userId);
  marketIds.push(marketId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `settlement-${userId}`,
    profileComplete: true,
    virtualBalance: '1000',
    totalDeposited: '1000',
    updatedAt: new Date(),
  });
  await dbWrite.insert(markets).values({
    id: marketId,
    question: 'Prediction settlement regression',
    yesShares: '500',
    noShares: '500',
    liquidity: '1000',
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  return { userId, marketId, agent: { userId, agentId: userId } };
}

async function state(userId: string, marketId: string) {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  const [market] = await dbWrite
    .select()
    .from(markets)
    .where(eq(markets.id, marketId));
  const holdings = await dbWrite
    .select()
    .from(positions)
    .where(eq(positions.marketId, marketId));
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  const fees = await dbWrite
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, userId));
  return {
    balance: Number(user?.virtualBalance),
    pnl: Number(user?.lifetimePnL),
    market,
    holdings,
    ledger,
    fees,
    feesPaid: Number(user?.totalFeesPaid),
  };
}

// Hold the real market row until both requests are waiting in Postgres. This
// reproduces the old stale-read race without mocking either database or wallet.
async function contend<T>(
  marketId: string,
  operations: Array<() => Promise<T>>
) {
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = dbWrite.transaction(async (tx) => {
    await tx
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, marketId))
      .for('update');
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const pending = Promise.allSettled(
    operations.map((operation) => operation())
  );
  try {
    const deadline = Date.now() + 3000;
    let waiting = 0;
    while (waiting < operations.length && Date.now() < deadline) {
      const rows = await dbWrite.execute(sql<{ count: number }>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query ILIKE '%Market%' OR query ILIKE '%pg_advisory_xact_lock%')
      `);
      waiting = Number(rows[0]?.count ?? 0);
      if (waiting < operations.length) await Bun.sleep(10);
    }
    expect(waiting).toBe(operations.length);
  } finally {
    release.resolve();
    await blocker;
  }
  return pending;
}

afterAll(async () => {
  if (marketIds.length) {
    await dbWrite
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, marketIds));
    await dbWrite
      .delete(positions)
      .where(inArray(positions.marketId, marketIds));
    await dbWrite.delete(markets).where(inArray(markets.id, marketIds));
  }
  if (userIds.length) {
    await dbWrite
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, userIds));
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, userIds));
    await dbWrite.delete(users).where(inArray(users.id, userIds));
  }
});

describe('atomic prediction settlement with real Postgres and wallet', () => {
  it('allows one overlapping full MCP sell and credits it once', async () => {
    const f = await fixture();
    const bought = await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const sell = () =>
      executeSellShares(f.agent, {
        positionId: bought.position.id,
        shares: bought.position.shares,
      });
    const results = await contend(f.marketId, [sell, sell]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    const after = await state(f.userId, f.marketId);
    expect(after.balance).toBe(999.98);
    expect(Number(after.holdings[0]?.shares)).toBe(0);
    expect(after.holdings[0]?.status).toBe('closed');
    expect(after.ledger.filter((row) => row.type === 'pred_sell')).toHaveLength(
      1
    );
  });

  for (const fraction of [0.4, 0.6]) {
    it(`serializes two ${fraction * 100}% MCP sells without overselling`, async () => {
      const f = await fixture();
      const bought = await executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount: 10,
      });
      const sell = () =>
        executeSellShares(f.agent, {
          positionId: bought.position.id,
          shares: bought.position.shares * fraction,
        });
      const results = await contend(f.marketId, [sell, sell]);
      const sold = fraction === 0.4 ? 2 : 1;
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(sold);
      const after = await state(f.userId, f.marketId);
      expect(Number(after.holdings[0]?.shares)).toBeCloseTo(
        bought.position.shares * (1 - sold * fraction),
        6
      );
      expect(
        after.ledger.filter((row) => row.type === 'pred_sell')
      ).toHaveLength(sold);
      expect(after.balance).toBeLessThanOrEqual(1000);
    });
  }

  it('includes both concurrent buys in the pool and holding', async () => {
    const f = await fixture();
    const buy = () =>
      executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount: 10,
      });
    const results = await contend(f.marketId, [buy, buy]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const after = await state(f.userId, f.marketId);
    expect(after.balance).toBe(980);
    expect(Number(after.market?.liquidity)).toBeCloseTo(1019.98, 7);
    expect(after.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      2
    );
    expect(after.holdings).toHaveLength(1);
  });

  it('rolls back a buy, wallet ledger and pool when a later SQL statement fails', async () => {
    const f = await fixture();
    const before = await state(f.userId, f.marketId);
    let invalidations = 0;
    await expect(
      withPredictionSettlement(
        f.marketId,
        { userId: f.userId },
        async (service, tx) => {
          await service.buy({
            userId: f.userId,
            marketId: f.marketId,
            side: 'yes',
            amount: 10,
          });
          await tx.execute(sql`SELECT 1 / 0`);
        },
        {
          ...options,
          cache: {
            invalidate: async () => {
              invalidations++;
            },
          },
        }
      )
    ).rejects.toThrow();
    expect(await state(f.userId, f.marketId)).toEqual(before);
    expect(invalidations).toBe(0);
  });

  it('rolls back the entire trade if fee accounting fails', async () => {
    const f = await fixture();
    const before = await state(f.userId, f.marketId);
    await expect(
      withPredictionSettlement(
        f.marketId,
        { userId: f.userId },
        (service) =>
          service.buy({
            userId: f.userId,
            marketId: f.marketId,
            side: 'yes',
            amount: 10,
          }),
        {
          ...options,
          feeProcessor: (tx) => ({
            processTradingFee: async (payment) => {
              const result = await FeeService.processTradingFee(
                payment.userId,
                payment.type as FeeType,
                payment.amount,
                payment.positionId,
                payment.relatedId,
                tx
              );
              await tx.execute(sql`SELECT 1 / 0`);
              return result;
            },
          }),
        }
      )
    ).rejects.toThrow();
    expect(await state(f.userId, f.marketId)).toEqual(before);
  });

  it('rolls back a sell when its real wallet credit fails and permits a safe retry', async () => {
    const f = await fixture();
    const bought = await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const before = await state(f.userId, f.marketId);
    await expect(
      withPredictionSettlement(
        f.marketId,
        { userId: f.userId },
        (service) =>
          service.sell({
            userId: f.userId,
            marketId: f.marketId,
            shares: bought.position.shares,
            positionId: bought.position.id,
          }),
        {
          ...options,
          wallet: (tx, afterCommit) => {
            const wallet = createUserWalletAdapter(tx, afterCommit);
            return {
              ...wallet,
              credit: async (payment) => {
                await wallet.credit(payment);
                await tx.execute(sql`SELECT 1 / 0`);
              },
            };
          },
        }
      )
    ).rejects.toThrow();
    expect(await state(f.userId, f.marketId)).toEqual(before);
    await executeSellShares(f.agent, {
      positionId: bought.position.id,
      shares: bought.position.shares,
    });
    expect((await state(f.userId, f.marketId)).balance).toBe(999.98);
  });

  for (const operation of ['resolve', 'cancel'] as const) {
    it(`serializes ${operation} against a sell and never settles those shares twice`, async () => {
      const f = await fixture();
      const bought = await executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount: 10,
      });
      const settle = () =>
        withPredictionSettlement(
          f.marketId,
          { system: 'settlement_test' },
          (service) =>
            operation === 'resolve'
              ? service.resolve({ marketId: f.marketId, winningSide: 'yes' })
              : service
                  .cancel({ marketId: f.marketId, reason: 'Regression' })
                  .then(() => undefined),
          options
        );
      const results = await contend<unknown>(f.marketId, [
        settle,
        () =>
          executeSellShares(f.agent, {
            positionId: bought.position.id,
            shares: bought.position.shares,
          }),
      ]);
      expect(results[0]?.status).toBe('fulfilled');
      const after = await state(f.userId, f.marketId);
      expect(after.ledger.filter((row) => Number(row.amount) > 0)).toHaveLength(
        1
      );
      await settle();
      expect(await state(f.userId, f.marketId)).toEqual(after);
    });
  }

  it('rolls back every payout when one wallet fails during multi-owner resolution', async () => {
    const f = await fixture();
    const other = await fixture();
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    await executeBuyShares(other.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const before = await state(f.userId, f.marketId);
    const otherBefore = await state(other.userId, f.marketId);
    await expect(
      withPredictionSettlement(
        f.marketId,
        { system: 'settlement_test' },
        (service) =>
          service.resolve({ marketId: f.marketId, winningSide: 'yes' }),
        {
          ...options,
          wallet: (tx, afterCommit) => {
            const wallet = createUserWalletAdapter(tx, afterCommit);
            return {
              ...wallet,
              credit: async (payment) => {
                await wallet.credit(payment);
                if (payment.userId === other.userId)
                  await tx.execute(sql`SELECT 1 / 0`);
              },
            };
          },
        }
      )
    ).rejects.toThrow();
    expect(await state(f.userId, f.marketId)).toEqual(before);
    expect(await state(other.userId, f.marketId)).toEqual(otherBefore);
    await withPredictionSettlement(
      f.marketId,
      { system: 'settlement_test' },
      (service) =>
        service.resolve({ marketId: f.marketId, winningSide: 'yes' }),
      options
    );
    for (const userId of [f.userId, other.userId]) {
      const after = await state(userId, f.marketId);
      expect(after.market?.resolved).toBe(true);
      expect(
        after.ledger.filter((row) => row.type === 'pred_resolve')
      ).toHaveLength(1);
    }
  });

  it('runs effects after commit and returns the committed trade despite notification failure', async () => {
    const f = await fixture();
    let committedBalance: number | undefined;
    const result = await withPredictionSettlement(
      f.marketId,
      { userId: f.userId },
      (service) =>
        service.buy({
          userId: f.userId,
          marketId: f.marketId,
          side: 'yes',
          amount: 10,
        }),
      {
        ...options,
        broadcast: {
          emit: () => {
            throw new Error('Broadcast unavailable');
          },
        },
        cache: {
          invalidate: async () => {
            committedBalance = (await state(f.userId, f.marketId)).balance;
            throw new Error('Cache unavailable');
          },
        },
      }
    );
    expect(result.shares).toBeGreaterThan(0);
    expect(committedBalance).toBe(990);
    expect(
      (await state(f.userId, f.marketId)).ledger.filter(
        (row) => row.type === 'pred_buy'
      )
    ).toHaveLength(1);
  });

  it('preserves MCP ownership enforcement', async () => {
    const f = await fixture();
    const other = await fixture();
    const bought = await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const before = await state(f.userId, f.marketId);
    await expect(
      executeSellShares(other.agent, {
        positionId: bought.position.id,
        shares: bought.position.shares,
      })
    ).rejects.toThrow('access denied');
    expect(await state(f.userId, f.marketId)).toEqual(before);
    expect((await state(other.userId, other.marketId)).balance).toBe(1000);
  });
});
