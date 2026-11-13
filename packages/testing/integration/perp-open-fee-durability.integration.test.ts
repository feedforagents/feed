/** PRD §§9.1/9.3: a committed open succeeds with fee work durably accounted for. */
import { expect, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createTradingFeeOutboxAdapter,
  createTradingFeeProcessor,
  createUserWalletAdapter,
  drainTradingFeeOutboxBatch,
  FEE_CONFIG,
  FeeService,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { openPerpAction } from '../../../packages/agents/src/plugins/plugin-agent-core/src/actions/open-perp';

for (const side of ['long', 'short'] as const) {
  for (const outage of ['transient', 'persistent'] as const) {
    test(`${side}: ${outage} fee failure has completed or queued fee work before open returns`, async () => {
      const userId = await generateSnowflakeId(),
        ticker = `FEEOPEN${userId}`;
      let attempts = 0;
      try {
        await db.insert(users).values({
          id: userId,
          username: `fee-open-${userId}`,
          virtualBalance: '10000',
          totalDeposited: '10000',
          updatedAt: new Date(),
        });
        await db.insert(organizationState).values({
          id: ticker,
          currentPrice: 100,
          basePrice: 100,
          updatedAt: new Date(),
        });
        await db.insert(perpMarketSnapshots).values({
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
            predictedRate: 0,
            nextFundingTime: new Date().toISOString(),
          },
        });
        const service = new PerpMarketService({
          db: new PerpDbAdapter(),
          wallet: createUserWalletAdapter(),
          settlement: createPerpSettlement(),
          fees: {
            tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
            platformShare: FEE_CONFIG.PLATFORM_SHARE,
            referrerShare: FEE_CONFIG.REFERRER_SHARE,
            minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
          },
          tradingFeeOutbox: createTradingFeeOutboxAdapter(),
          feeProcessor: {
            processTradingFee: async (params) => {
              attempts++;
              // Fault injection at the fee boundary only. All settlement, fee
              // recovery and durable outbox operations use their real services.
              if (outage === 'persistent' || attempts < 3)
                throw new Error('Owned fee-ledger outage');
              return FeeService.processTradingFee(
                params.userId,
                FEE_CONFIG.FEE_TYPES.PERP_OPEN,
                params.amount,
                params.positionId,
                params.relatedId
              );
            },
          },
        });
        const result = await service.openPosition({
          userId,
          ticker,
          side,
          size: 1000,
          leverage: 10,
        });
        expect(result.positionId).toBeString();
        const [owner] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(Number(owner!.virtualBalance)).toBe(9899);
        const open = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.userId, userId));
        expect(open).toHaveLength(1);
        expect(open[0]!.size).toBe(1000);
        const debits = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, userId));
        expect(debits.filter((r) => r.type === 'perp_open')).toHaveLength(1);
        const queued = await db
          .select()
          .from(tradingFeeOutbox)
          .where(eq(tradingFeeOutbox.userId, userId));
        const recorded = await db
          .select()
          .from(tradingFees)
          .where(eq(tradingFees.userId, userId));
        expect(queued).toHaveLength(outage === 'persistent' ? 1 : 0);
        expect(recorded).toHaveLength(outage === 'transient' ? 1 : 0);
        expect(attempts).toBe(3);
        if (outage === 'persistent') {
          expect(queued[0]!.tradeId).toBe(result.positionId);
          expect(queued[0]!.tradeType).toBe('perp_open');
          expect(Number(queued[0]!.tradeAmount)).toBe(1000);
        }
      } finally {
        // The unfixed candidate returns while retries still run. Wait for its
        // owned work before removing fixtures, even when the assertion fails.
        await Bun.sleep(600);
        for (const table of [
          tradingFeeOutbox,
          tradingFees,
          pointsTransactions,
          balanceTransactions,
          perpPositions,
        ])
          await db.delete(table).where(eq(table.userId, userId));
        await db
          .delete(perpMarketSnapshots)
          .where(eq(perpMarketSnapshots.ticker, ticker));
        await db
          .delete(organizationState)
          .where(eq(organizationState.id, ticker));
        await db.delete(users).where(eq(users.id, userId));
      }
    });
  }
}

async function createFeeMarketFixture(ticker: string) {
  await db.insert(organizationState).values({
    id: ticker,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: new Date(),
  });
  await db.insert(perpMarketSnapshots).values({
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
      predictedRate: 0,
      nextFundingTime: new Date().toISOString(),
    },
  });
}

async function cleanupFeeMarketFixture(
  userId: string,
  ticker: string,
  extraUserIds: string[] = []
) {
  for (const table of [
    tradingFeeOutbox,
    tradingFees,
    pointsTransactions,
    balanceTransactions,
    perpPositions,
  ])
    await db.delete(table).where(eq(table.userId, userId));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await db.delete(organizationState).where(eq(organizationState.id, ticker));
  await db.delete(users).where(eq(users.id, userId));
  for (const extraId of extraUserIds) {
    for (const table of [tradingFees, balanceTransactions])
      await db.delete(table).where(eq(table.userId, extraId));
    await db.delete(users).where(eq(users.id, extraId));
  }
}

/** Close-leg fee work is fire-and-forget; poll until the rows land. */
async function waitForFeeRows(
  userId: string,
  tradeType: string,
  count: number,
  timeoutMs = 5000
) {
  const started = Date.now();
  for (;;) {
    const rows = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    const matched = rows.filter((r) => r.tradeType === tradeType);
    if (matched.length >= count || Date.now() - started > timeoutMs)
      return matched;
    await Bun.sleep(100);
  }
}

test('fuzzy commit: first fee attempt writes then throws, retry charges exactly once', async () => {
  const userId = await generateSnowflakeId();
  const referrerId = await generateSnowflakeId();
  const ticker = `FEEFUZZ${userId}`;
  let attempts = 0;
  let seenOperationId: string | null = null;
  try {
    await db.insert(users).values({
      id: referrerId,
      username: `fee-ref-${referrerId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await db.insert(users).values({
      id: userId,
      username: `fee-fuzz-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      referredBy: referrerId,
      updatedAt: new Date(),
    });
    await createFeeMarketFixture(ticker);
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradingFeeOutbox: createTradingFeeOutboxAdapter(),
      feeProcessor: {
        processTradingFee: async (params) => {
          attempts++;
          if (params.operationId) seenOperationId = params.operationId;
          // Ambiguous commit: the fee row really commits, then the caller
          // only sees an error. The retry must find the stored row.
          const result = await FeeService.processTradingFee(
            params.userId,
            FEE_CONFIG.FEE_TYPES.PERP_OPEN,
            params.amount,
            params.positionId,
            params.relatedId,
            undefined,
            params.operationId
          );
          if (attempts === 1) throw new Error('connection reset after commit');
          return result;
        },
      },
    });
    const result = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    expect(result.positionId).toBeString();
    expect(attempts).toBe(2);
    const recorded = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.tradeType).toBe('perp_open');
    expect(seenOperationId).toBeString();
    expect(recorded[0]!.idempotencyKey).toBe(seenOperationId);
    expect(Number(recorded[0]!.feeAmount)).toBe(1);
    expect(Number(recorded[0]!.referrerFee)).toBe(0);
    expect(recorded[0]!.referrerId).toBeNull();
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(owner!.totalFeesPaid)).toBe(1);
    const [referrer] = await db
      .select()
      .from(users)
      .where(eq(users.id, referrerId));
    expect(Number(referrer!.totalFeesEarned)).toBe(0);
    const referralTx = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, referrerId));
    expect(
      referralTx.filter((r) => r.type === 'referral_fee_earned')
    ).toHaveLength(0);
    const queued = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    expect(queued).toHaveLength(0);
  } finally {
    await Bun.sleep(600);
    await cleanupFeeMarketFixture(userId, ticker, [referrerId]);
  }
});

test('persistent fee failure: open succeeds, drain writes exactly one fee row', async () => {
  const userId = await generateSnowflakeId();
  const ticker = `FEEDRAIN${userId}`;
  try {
    await db.insert(users).values({
      id: userId,
      username: `fee-drain-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await createFeeMarketFixture(ticker);
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradingFeeOutbox: createTradingFeeOutboxAdapter(),
      feeProcessor: {
        processTradingFee: async () => {
          throw new Error('Owned fee-ledger outage');
        },
      },
    });
    const result = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    expect(result.positionId).toBeString();
    const queued = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.tradeType).toBe('perp_open');
    const queuedKey = queued[0]!.idempotencyKey;
    expect(queuedKey).toBeString();

    const drained = await drainTradingFeeOutboxBatch();
    expect(drained).toEqual({ examined: 1, processed: 1, failed: 0 });
    const recorded = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.idempotencyKey).toBe(queuedKey);
    expect(Number(recorded[0]!.feeAmount)).toBe(1);
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(owner!.totalFeesPaid)).toBe(1);
    const queuedAfter = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    expect(queuedAfter).toHaveLength(0);

    const drainedAgain = await drainTradingFeeOutboxBatch();
    expect(drainedAgain).toEqual({ examined: 0, processed: 0, failed: 0 });
    const recordedAgain = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(recordedAgain).toHaveLength(1);
  } finally {
    await Bun.sleep(600);
    await cleanupFeeMarketFixture(userId, ticker);
  }
});

test('two partial closes write two perp_close fee rows', async () => {
  const userId = await generateSnowflakeId();
  const ticker = `FEEPART${userId}`;
  try {
    await db.insert(users).values({
      id: userId,
      username: `fee-part-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await createFeeMarketFixture(ticker);
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradingFeeOutbox: createTradingFeeOutboxAdapter(),
      feeProcessor: createTradingFeeProcessor(),
    });
    const opened = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    // Each close is 40% of the remaining size: 400 then 240.
    await service.closePosition({
      userId,
      positionId: opened.positionId,
      percentage: 0.4,
    });
    await service.closePosition({
      userId,
      positionId: opened.positionId,
      percentage: 0.4,
    });
    const closes = await waitForFeeRows(userId, 'perp_close', 2);
    expect(closes).toHaveLength(2);
    // Same position, two legitimate closes: each close gets its own key,
    // so neither is deduped away. Open 1.00 + closes 0.40 + 0.24.
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(owner!.totalFeesPaid)).toBeCloseTo(1.64, 6);
    const [pos] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, opened.positionId));
    expect(Number(pos!.size)).toBeCloseTo(360, 6);
  } finally {
    await Bun.sleep(600);
    await cleanupFeeMarketFixture(userId, ticker);
  }
});

test('partial close still succeeds when the clock rolls back right after the post-settlement balance read', async () => {
  const userId = await generateSnowflakeId();
  const ticker = `FEEROLL${userId}`;
  const realDateNow = Date.now;
  let rollbackArmed = false;
  try {
    await db.insert(users).values({
      id: userId,
      username: `fee-roll-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await createFeeMarketFixture(ticker);
    const realWallet = createUserWalletAdapter();
    const service = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: {
        ...realWallet,
        // Roll the clock back by one second immediately after the real
        // post-settlement balance read, reproducing the reviewer's case:
        // the close has already settled when the rollback lands.
        getBalance: async (uid: string) => {
          const result = await realWallet.getBalance(uid);
          if (rollbackArmed) {
            rollbackArmed = false;
            Date.now = () => realDateNow() - 1000;
          }
          return result;
        },
      },
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradingFeeOutbox: createTradingFeeOutboxAdapter(),
      feeProcessor: createTradingFeeProcessor(),
    });
    const opened = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    expect(opened.size).toBeCloseTo(1000, 6);
    // Pin the snowflake generator's last timestamp to "now" so the
    // one-second rollback is actually backwards for the next id.
    await generateSnowflakeId();
    rollbackArmed = true;
    // 40% partial close. Before the fix this threw "Clock moved
    // backwards" after the position had already gone 1000 -> 600.
    const closed = await service.closePosition({
      userId,
      positionId: opened.positionId,
      percentage: 0.4,
    });
    // Restore the clock right away so the fee retries (100/200/400ms
    // backoff) can land; the close itself already succeeded.
    Date.now = realDateNow;
    expect(closed.size).toBeCloseTo(400, 6);
    expect(closed.remainingSize).toBeCloseTo(600, 6);
    // Settlement credited the close (balance rose from the 9899
    // post-open level). The exact figure depends on the fixture
    // market's AMM impact on the exit price, so assert the direction,
    // not the number.
    expect(closed.balance).toBeGreaterThan(9899);
    const [pos] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, opened.positionId));
    expect(Number(pos!.size)).toBeCloseTo(600, 6);
    const closes = await waitForFeeRows(userId, 'perp_close', 1);
    expect(closes).toHaveLength(1);
    expect(Number(closes[0]!.feeAmount)).toBeCloseTo(0.4, 6);
  } finally {
    Date.now = realDateNow;
    await Bun.sleep(600);
    await cleanupFeeMarketFixture(userId, ticker);
  }
});

test('plugin openPerpAction with failing fees succeeds and the same fee intent retries once', async () => {
  const userId = await generateSnowflakeId();
  const ticker = `FEEPLUG${userId}`;
  const original = FeeService.processTradingFee;
  try {
    await db.insert(users).values({
      id: userId,
      username: `fee-plug-${userId}`,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await createFeeMarketFixture(ticker);
    // Fail every fee attempt: the handler must still report success.
    FeeService.processTradingFee = async () => {
      throw new Error('Owned fee-ledger outage');
    };
    const runtime = { agentId: userId } as IAgentRuntime;
    const message = {} as Memory;
    const state = {
      data: {
        actionParams: { ticker, side: 'LONG', amount: 100, leverage: 5 },
      },
    } as unknown as State;
    const result = await openPerpAction.handler(runtime, message, state);
    expect(result?.success).toBe(true);
    const positionId = (result?.data as { positionId?: string } | undefined)
      ?.positionId;
    expect(positionId).toBeString();
    const open = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(open).toHaveLength(1);
    const queued = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    expect(queued).toHaveLength(1);
    const operationId = queued[0]!.idempotencyKey;
    expect(operationId).toBeString();
    // The open's margin was debited exactly once.
    const debits = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    expect(debits.filter((r) => r.type === 'perp_open')).toHaveLength(1);

    // Restore the real fee ledger, drain the queued intent, then retry the
    // same fee intent: the stored row is returned, nothing is charged twice.
    FeeService.processTradingFee = original;
    const drained = await drainTradingFeeOutboxBatch();
    expect(drained.processed).toBe(1);
    const processor = createTradingFeeProcessor();
    const retry = await processor.processTradingFee({
      userId,
      amount: 500,
      type: 'perp_open',
      relatedId: ticker,
      positionId: positionId!,
      operationId: operationId ?? undefined,
    });
    expect(retry.feeCharged).toBe(0.5);
    const recorded = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(recorded).toHaveLength(1);
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(owner!.totalFeesPaid)).toBe(0.5);
    const openAfter = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(openAfter).toHaveLength(1);
    const debitsAfter = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    expect(debitsAfter.filter((r) => r.type === 'perp_open')).toHaveLength(1);
  } finally {
    FeeService.processTradingFee = original;
    await Bun.sleep(600);
    await cleanupFeeMarketFixture(userId, ticker);
  }
});
