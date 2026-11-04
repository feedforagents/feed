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
  sql,
  tradingFees,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeClosePosition,
  executeOpenPosition,
} from '../../mcp/src/handlers/tool-handlers';

const owners: string[] = [];
const tickers: string[] = [];
const fees = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

async function fixture() {
  const userId = await generateSnowflakeId();
  owners.push(userId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `perp-lock-${userId}`,
    virtualBalance: '10000',
    totalDeposited: '10000',
    profileComplete: true,
    updatedAt: new Date(),
  });
  const markets = [`PA${userId}`, `PB${userId}`];
  for (const ticker of markets) {
    tickers.push(ticker);
    await dbWrite.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await dbWrite.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: ticker,
      currentPrice: 100,
      markPrice: 100,
      indexPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 1000000,
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
  }
  return { userId, agent: { userId, agentId: userId }, markets };
}

async function state(userId: string) {
  const positions = await dbWrite
    .select()
    .from(perpPositions)
    .where(eq(perpPositions.userId, userId));
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  return {
    positions,
    ledger,
    balance: Number(user?.virtualBalance),
    pnl: Number(user?.lifetimePnL),
    exposure: positions
      .filter((p) => !p.closedAt)
      .reduce((sum, p) => sum + p.size * p.leverage, 0),
  };
}

// Old requests read exposure before waiting on the wallet row. The fixed
// requests wait on that row or the common owner lock before committing.
async function contend<T>(userId: string, operations: Array<() => Promise<T>>) {
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = dbWrite.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const pending = Promise.allSettled(
    operations.map((operation) => operation())
  );
  try {
    const until = Date.now() + 3000;
    let count = 0;
    while (count < operations.length && Date.now() < until) {
      const rows = await dbWrite.execute(
        sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND (query ILIKE '%User%' OR query ILIKE '%pg_advisory_xact_lock%')`
      );
      count = Number(rows[0]?.count ?? 0);
      if (count < operations.length) await Bun.sleep(10);
    }
    expect(count).toBe(operations.length);
  } finally {
    release.resolve();
    await blocker;
  }
  return pending;
}

afterAll(async () => {
  if (owners.length) {
    await dbWrite
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, owners));
    await dbWrite
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, owners));
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

describe('per-owner perpetual exposure with real Postgres and wallet', () => {
  for (const [marketCap, legacyLeverage, requestedLeverage] of [
    [100, 100, 20],
    [10, 20, 10],
  ] as const) {
    it(`blocks a legacy ${legacyLeverage}x add at market cap ${marketCap} while allowing reductions`, async () => {
      const f = await fixture();
      const ticker = f.markets[0]!;
      await dbWrite
        .update(perpMarketSnapshots)
        .set({ maxLeverage: marketCap })
        .where(eq(perpMarketSnapshots.ticker, ticker));
      const id = await generateSnowflakeId();
      await dbWrite.transaction(async (tx) => {
        await tx.insert(perpPositions).values({
          id,
          userId: f.userId,
          ticker,
          organizationId: ticker,
          side: 'long',
          entryPrice: 100,
          currentPrice: 100,
          size: 1000,
          leverage: legacyLeverage,
          liquidationPrice: 0,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          lastUpdated: new Date(),
        });
        await createUserWalletAdapter(tx).debit({
          userId: f.userId,
          amount: 1000 / legacyLeverage,
          reason: 'perp_open',
          description: 'Fund a historical over-cap position fixture',
          relatedId: id,
        });
      });
      const before = await state(f.userId);
      await expect(
        executeOpenPosition(f.agent, {
          ticker,
          side: 'LONG',
          amount: 1000,
          leverage: requestedLeverage,
        })
      ).rejects.toThrow('above the leverage cap');
      expect(await state(f.userId)).toEqual(before);
      const service = new PerpMarketService({
        db: new PerpDbAdapter(),
        wallet: createUserWalletAdapter(),
        fees,
        settlement: createPerpSettlement(),
      });
      await service.closePosition({
        userId: f.userId,
        positionId: id,
        percentage: 0.5,
      });
      const reduced = await state(f.userId);
      expect(reduced.positions[0]?.size).toBe(500);
      expect(reduced.positions[0]?.leverage).toBe(legacyLeverage);
      expect(reduced.positions[0]?.closedAt).toBeNull();
      await executeClosePosition(f.agent, { positionId: id });
      const closed = await state(f.userId);
      expect(closed.positions[0]?.closedAt).not.toBeNull();
      expect(
        closed.ledger.filter((row) => row.type === 'perp_add_to_position')
      ).toHaveLength(0);
      expect(
        closed.ledger.filter((row) => row.type === 'perp_close')
      ).toHaveLength(1);
      expect(
        closed.ledger.filter((row) => row.type === 'perp_partial_close')
      ).toHaveLength(1);
    });
  }

  it('enforces 20x even on a stored 100x market, without charging a rejected order', async () => {
    const f = await fixture();
    const ticker = f.markets[0]!;
    await dbWrite
      .update(perpMarketSnapshots)
      .set({ maxLeverage: 100 })
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await expect(
      executeOpenPosition(f.agent, {
        ticker,
        side: 'LONG',
        amount: 1000,
        leverage: 21,
      })
    ).rejects.toThrow('Invalid leverage (1-20)');
    expect((await state(f.userId)).ledger).toHaveLength(0);
    expect((await state(f.userId)).balance).toBe(10000);
    await executeOpenPosition(f.agent, {
      ticker,
      side: 'LONG',
      amount: 1000,
      leverage: 20,
    });
    const after = await state(f.userId);
    expect(after.positions[0]?.leverage).toBe(20);
    expect(after.ledger.filter((row) => row.type === 'perp_open')).toHaveLength(
      1
    );
  });

  it('rejects the second cross-ticker MCP open before it spends any points', async () => {
    const f = await fixture();
    const results = await contend(
      f.userId,
      f.markets.map(
        (ticker) => () =>
          executeOpenPosition(f.agent, {
            ticker,
            side: 'LONG',
            amount: 30000,
            leverage: 20,
          })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await state(f.userId);
    expect(after.positions).toHaveLength(1);
    expect(after.exposure).toBe(600000);
    expect(after.balance).toBe(8470);
    expect(after.ledger.filter((row) => row.type === 'perp_open')).toHaveLength(
      1
    );
  });

  it('serializes an add against a fresh open on another ticker', async () => {
    const f = await fixture();
    await executeOpenPosition(f.agent, {
      ticker: f.markets[0]!,
      side: 'LONG',
      amount: 20000,
      leverage: 20,
    });
    const results = await contend(
      f.userId,
      f.markets.map(
        (ticker) => () =>
          executeOpenPosition(f.agent, {
            ticker,
            side: 'LONG',
            amount: 20000,
            leverage: 20,
          })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await state(f.userId);
    expect(after.exposure).toBe(800000);
    expect(after.balance).toBe(7960);
    expect(after.ledger).toHaveLength(2);
  });

  it('serializes a flip against another ticker without counting its replaced leg', async () => {
    const f = await fixture();
    await executeOpenPosition(f.agent, {
      ticker: f.markets[0]!,
      side: 'LONG',
      amount: 10000,
      leverage: 20,
    });
    const results = await contend(f.userId, [
      () =>
        executeOpenPosition(f.agent, {
          ticker: f.markets[0]!,
          side: 'SHORT',
          amount: 40000,
          leverage: 20,
        }),
      () =>
        executeOpenPosition(f.agent, {
          ticker: f.markets[1]!,
          side: 'LONG',
          amount: 30000,
          leverage: 20,
        }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await state(f.userId);
    expect(after.exposure).toBeLessThanOrEqual(1000000);
    expect([600000, 800000]).toContain(after.exposure);
    expect(after.ledger).toHaveLength(2);
  });

  it('does not create duplicate active positions for simultaneous first opens on one ticker', async () => {
    const f = await fixture();
    const open = () =>
      executeOpenPosition(f.agent, {
        ticker: f.markets[0]!,
        side: 'LONG',
        amount: 10000,
        leverage: 20,
      });
    const results = await contend(f.userId, [open, open]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await state(f.userId)).positions).toHaveLength(1);
    await open();
    expect((await state(f.userId)).exposure).toBe(400000);
  });

  it('keeps the exposure limit per owner rather than per process or ticker', async () => {
    const a = await fixture();
    const b = await fixture();
    await Promise.all(
      [a, b].map((f) =>
        executeOpenPosition(f.agent, {
          ticker: a.markets[0]!,
          side: 'LONG',
          amount: 30000,
          leverage: 20,
        })
      )
    );
    expect((await state(a.userId)).exposure).toBe(600000);
    expect((await state(b.userId)).exposure).toBe(600000);
  });

  it('enforces the existing position count when two opens compete for the last slot', async () => {
    const f = await fixture();
    await dbWrite.insert(perpPositions).values(
      Array.from({ length: 49 }, (_, index) => ({
        id: `cap-${f.userId}-${index}`,
        userId: f.userId,
        ticker: `CAP${index}`,
        organizationId: `CAP${index}`,
        side: 'long',
        entryPrice: 100,
        currentPrice: 100,
        size: 10,
        leverage: 1,
        liquidationPrice: 50,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        lastUpdated: new Date(),
      }))
    );
    const results = await contend(
      f.userId,
      f.markets.map(
        (ticker) => () =>
          executeOpenPosition(f.agent, {
            ticker,
            side: 'LONG',
            amount: 1000,
            leverage: 1,
          })
      )
    );
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect((await state(f.userId)).positions).toHaveLength(50);
    expect((await state(f.userId)).balance).toBe(8999);
  });

  for (const side of ['long', 'short'] as const) {
    it(`rejects a stale ${side === 'long' ? 'add' : 'flip'} after a position changes owners`, async () => {
      const f = await fixture();
      const other = await fixture();
      await executeOpenPosition(f.agent, {
        ticker: f.markets[0]!,
        side: 'LONG',
        amount: 10000,
        leverage: 20,
      });
      const before = await state(f.userId);
      const id = before.positions[0]!.id;
      const settlement = createPerpSettlement();
      const service = new PerpMarketService({
        db: new PerpDbAdapter(),
        wallet: createUserWalletAdapter(),
        fees,
        settlement: {
          run: async (userId, operation) => {
            // A real ownership change after preflight, before the locked read.
            await dbWrite
              .update(perpPositions)
              .set({ userId: other.userId })
              .where(eq(perpPositions.id, id));
            return settlement.run(userId, operation);
          },
        },
      });
      await expect(
        service.openPosition({
          userId: f.userId,
          ticker: f.markets[0]!,
          side,
          size: side === 'long' ? 1000 : 30000,
          leverage: 20,
        })
      ).rejects.toThrow('Position changed concurrently');
      const after = await state(f.userId);
      expect(after.balance).toBe(before.balance);
      expect(after.pnl).toBe(before.pnl);
      expect(after.ledger).toEqual(before.ledger);
      const transferred = await state(other.userId);
      expect(transferred.positions).toHaveLength(1);
      expect(transferred.positions[0]?.id).toBe(id);
      expect(transferred.positions[0]?.closedAt).toBeNull();
    });
  }

  it('rolls back both flip legs and wallet settlement when P&L bookkeeping fails', async () => {
    const f = await fixture();
    await executeOpenPosition(f.agent, {
      ticker: f.markets[0]!,
      side: 'LONG',
      amount: 10000,
      leverage: 20,
    });
    const before = await state(f.userId);
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      fees,
      settlement: createPerpSettlement({
        wallet: (_userId, tx, afterCommit) => {
          const wallet = createUserWalletAdapter(tx, afterCommit);
          return {
            ...wallet,
            recordPnL: async (payment) => {
              await wallet.recordPnL(payment);
              await tx.execute(sql`SELECT 1 / 0`);
            },
          };
        },
      }),
    });
    await expect(
      service.openPosition({
        userId: f.userId,
        ticker: f.markets[0]!,
        side: 'short',
        size: 30000,
        leverage: 20,
      })
    ).rejects.toThrow();
    expect(await state(f.userId)).toEqual(before);
  });

  it('rolls back margin, ledger, position and open interest when bookkeeping fails', async () => {
    const f = await fixture();
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      fees,
      settlement: createPerpSettlement({
        wallet: (_userId, tx, afterCommit) => {
          const wallet = createUserWalletAdapter(tx, afterCommit);
          return {
            ...wallet,
            recordPnL: async (payment) => {
              await wallet.recordPnL(payment);
              await tx.execute(sql`SELECT 1 / 0`);
            },
          };
        },
      }),
    });
    await expect(
      service.openPosition({
        userId: f.userId,
        ticker: f.markets[0]!,
        side: 'long',
        size: 30000,
        leverage: 20,
      })
    ).rejects.toThrow();
    const after = await state(f.userId);
    expect(after.balance).toBe(10000);
    expect(after.pnl).toBe(0);
    expect(after.positions).toHaveLength(0);
    expect(after.ledger).toHaveLength(0);
    const [market] = await dbWrite
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, f.markets[0]!));
    expect(market?.openInterest).toBe(1000000);
    await executeOpenPosition(f.agent, {
      ticker: f.markets[0]!,
      side: 'LONG',
      amount: 30000,
      leverage: 20,
    });
    expect((await state(f.userId)).exposure).toBe(600000);
  });
});
