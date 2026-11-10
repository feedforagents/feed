/**
 * A2A fee accounting: charged fees must agree with the fee ledger.
 *
 * Runs against a real Postgres database (DATABASE_URL) through the real
 * A2A executor (`FeedAgentExecutor.executeDirectly`), because the defect
 * is a mismatch between two live code paths: the market services charge
 * the fee in their trade math (`deps.fees.tradingFeeRate`) while
 * `FeeService.processTradingFee` records `tradeAmount * 0.001`.
 *
 * PRD §§8.1/9.1/9.6 and MVP Phases 3/6 require charged fees, ledger
 * allocations and trader totals to agree. For each trade the test asserts
 * the invariant, not a literal rate:
 *   recorded fee rows == charged fee (result.fee.amount)
 *   trader totalFeesPaid delta == charged fee
 *   referrer credit == FEE_CONFIG.REFERRER_SHARE * charged fee
 * (#1585 merged, so the referrer share is 0: the platform keeps the fee.)
 *
 * Fee rows are asserted immediately when an action returns — never polled
 * for. Every fee path awaits `processFeeWithRetry`, so the fee is settled
 * inline (or the intent is in the outbox) before success is reported; a
 * poll would only prove eventual recovery while the process stays alive.
 * After asserting, each test drains the outbox once and verifies a second
 * drain changes nothing for its trader.
 *
 * The idempotent-recovery block below covers the remaining failure mode:
 * a fee write that commits but is observed as an error. Each fee leg
 * carries one `operationId`, reused across its retries, so the retry
 * replays the recorded fee instead of inserting a second row. The same
 * key is carried into the outbox when the retries exhaust, so the drain
 * replays under it too — the exhaustion and drain-replay cases below
 * cover that handoff. The tests fault-inject at the fee boundary only
 * (real FeeService, real Postgres, following
 * perp-open-fee-durability.integration.test.ts): the first attempt runs
 * the real settlement and then reports failure.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  and,
  balanceTransactions,
  db,
  eq,
  gameConfigs,
  inArray,
  isNull,
  markets,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  positions,
  sql,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
  FeeRedistributionService,
  FeeService,
  STABILITY_FUND_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import {
  createTradingFeeOutboxAdapter,
  drainTradingFeeOutboxBatch,
} from '../../../apps/web/src/lib/services/trading-fee-outbox';

const createdUserIds: string[] = [];
const createdMarketIds: string[] = [];
const createdTickers: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(referredBy?: string): Promise<string> {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `fee-acct-${userId.slice(-10)}`,
    profileComplete: true,
    virtualBalance: '10000',
    totalDeposited: '10000',
    referredBy: referredBy ?? null,
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function createPredictionMarket(): Promise<string> {
  const marketId = await generateSnowflakeId();
  await db.insert(markets).values({
    id: marketId,
    question: 'A2A fee accounting regression',
    yesShares: '50000',
    noShares: '50000',
    liquidity: '100000',
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  createdMarketIds.push(marketId);
  return marketId;
}

async function createPerpMarket(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const ticker = `FEEACCT${suffix}`.toUpperCase();
  const orgId = `fee-acct-org-${suffix}`;
  const now = new Date();
  await db.insert(organizationState).values({
    id: orgId,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: now,
  });
  // Register each successful insert before the next one can fail, so a
  // mid-setup failure still cleans up what already landed.
  createdOrgIds.push(orgId);
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'Fee Accounting Test Org',
    currentPrice: 100,
    high24h: 100,
    low24h: 100,
    openInterest: 0,
    volume24h: 0,
    fundingRate: {
      ticker,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
  createdTickers.push(ticker);
  return ticker;
}

type FeeState = {
  totalFeesPaid: number;
  referrerEarned: number;
};

async function readFeeState(
  traderId: string,
  referrerId: string
): Promise<FeeState> {
  const [trader] = await db
    .select({ totalFeesPaid: users.totalFeesPaid })
    .from(users)
    .where(eq(users.id, traderId));
  const [referrer] = await db
    .select({ totalFeesEarned: users.totalFeesEarned })
    .from(users)
    .where(eq(users.id, referrerId));
  return {
    totalFeesPaid: Number(trader?.totalFeesPaid ?? 0),
    referrerEarned: Number(referrer?.totalFeesEarned ?? 0),
  };
}

type TraderState = {
  balance: number;
  totalFeesPaid: number;
  fund: number;
};

async function readTraderState(traderId: string): Promise<TraderState> {
  const [user] = await db
    .select({
      virtualBalance: users.virtualBalance,
      totalFeesPaid: users.totalFeesPaid,
    })
    .from(users)
    .where(eq(users.id, traderId));
  return {
    balance: Number(user?.virtualBalance ?? 0),
    totalFeesPaid: Number(user?.totalFeesPaid ?? 0),
    fund: await FeeRedistributionService.getFundBalance(),
  };
}

function sum(rows: { feeAmount: string }[]): number {
  return rows.reduce((total, row) => total + Number(row.feeAmount), 0);
}

/**
 * Narrow an optional service-reported balance to a real finite number
 * before comparing it: a missing balance must fail the test, never be
 * cast or defaulted to zero.
 */
function assertFiniteNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected a finite number, got ${String(value)}`);
  }
}

function sumReferrer(rows: { referrerFee: string }[]): number {
  return rows.reduce((total, row) => total + Number(row.referrerFee), 0);
}

async function tradeTypeRows(traderId: string, tradeType: string) {
  const rows = await db
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, traderId));
  return rows.filter((row) => row.tradeType === tradeType);
}

/**
 * The outbox drain must change nothing for a trader whose fees settled
 * inline: run it once, then again, and verify fee rows, totals and
 * balance are identical after both runs.
 */
async function expectDrainChangesNothingFor(traderId: string) {
  const before = await readTraderState(traderId);
  const rowsBefore = await db
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, traderId));
  await drainTradingFeeOutboxBatch();
  const afterFirst = await readTraderState(traderId);
  const rowsAfterFirst = await db
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, traderId));
  await drainTradingFeeOutboxBatch();
  const afterSecond = await readTraderState(traderId);
  const rowsAfterSecond = await db
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, traderId));
  expect(rowsAfterFirst).toHaveLength(rowsBefore.length);
  expect(rowsAfterSecond).toHaveLength(rowsBefore.length);
  expect(afterFirst.totalFeesPaid).toBe(before.totalFeesPaid);
  expect(afterSecond.totalFeesPaid).toBe(before.totalFeesPaid);
  expect(afterFirst.balance).toBe(before.balance);
  expect(afterSecond.balance).toBe(before.balance);
}

/**
 * Cleanup failures collected across sections. A failed section must
 * not abort the remaining ones, must not be swallowed by a warning,
 * and must not be hidden by clearing the registries: the identities
 * stay registered until a readback confirms they are gone, and the
 * aggregate failure is thrown from afterAll so the run fails
 * truthfully instead of reporting a green file with leaked rows.
 */
const cleanupFailures: string[] = [];

/** Run one cleanup section; a failure is recorded, never swallowed. */
async function attempt(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cleanupFailures.push(`${label}: ${message}`);
    console.warn(`[fee-accounting cleanup] ${label} failed`, err);
  }
}

/** Fail the section when the readback still finds owned rows. */
async function expectGone(
  label: string,
  remaining: () => Promise<Array<unknown>>
) {
  const leftovers = await remaining();
  if (leftovers.length > 0) {
    throw new Error(`${leftovers.length} ${label} rows remain after cleanup`);
  }
}

afterAll(async () => {
  // Reverse only this file's own stability-fund contribution, computed
  // from its own fee rows before they are deleted: 30% of the platform
  // fee on each row. (The fund balance is a shared global; restoring an
  // absolute value would erase other tests' contributions.) The
  // aggregate sits inside the attempt boundary like every other
  // section, so a failure here cannot prevent the remaining cleanup.
  let ownDiversion = 0;
  await attempt('own fund contribution', async () => {
    if (createdUserIds.length) {
      const [agg] = await db
        .select({
          platformTotal: sql<string>`COALESCE(SUM(${tradingFees.platformFee}::numeric), 0)`,
        })
        .from(tradingFees)
        .where(inArray(tradingFees.userId, createdUserIds));
      ownDiversion =
        Number(agg?.platformTotal ?? 0) *
        STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE;
    }
  });
  if (ownDiversion > 0) {
    await attempt('stability fund reversal', async () => {
      await db
        .update(gameConfigs)
        .set({
          value: sql`to_json(COALESCE((${gameConfigs.value} #>> '{}')::numeric, 0) - ${ownDiversion})`,
          updatedAt: new Date(),
        })
        .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));
    });
  }
  await attempt('perp positions/snapshots', async () => {
    if (createdTickers.length) {
      await db
        .delete(perpPositions)
        .where(inArray(perpPositions.ticker, createdTickers));
      await db
        .delete(perpMarketSnapshots)
        .where(inArray(perpMarketSnapshots.ticker, createdTickers));
      await expectGone('perp position', async () =>
        db
          .select({ id: perpPositions.id })
          .from(perpPositions)
          .where(inArray(perpPositions.ticker, createdTickers))
      );
      await expectGone('perp snapshot', async () =>
        db
          .select({ ticker: perpMarketSnapshots.ticker })
          .from(perpMarketSnapshots)
          .where(inArray(perpMarketSnapshots.ticker, createdTickers))
      );
    }
  });
  await attempt('perp org state', async () => {
    if (createdOrgIds.length) {
      await db
        .delete(organizationState)
        .where(inArray(organizationState.id, createdOrgIds));
      await expectGone('perp org', async () =>
        db
          .select({ id: organizationState.id })
          .from(organizationState)
          .where(inArray(organizationState.id, createdOrgIds))
      );
    }
  });
  await attempt('prediction markets', async () => {
    if (createdMarketIds.length) {
      await db
        .delete(positions)
        .where(inArray(positions.marketId, createdMarketIds));
      await db.delete(markets).where(inArray(markets.id, createdMarketIds));
      await expectGone('prediction market', async () =>
        db
          .select({ id: markets.id })
          .from(markets)
          .where(inArray(markets.id, createdMarketIds))
      );
    }
  });
  await attempt('fee rows and outbox rows', async () => {
    if (createdUserIds.length) {
      await db
        .delete(tradingFees)
        .where(inArray(tradingFees.userId, createdUserIds));
      await db
        .delete(tradingFeeOutbox)
        .where(inArray(tradingFeeOutbox.userId, createdUserIds));
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.userId, createdUserIds));
      await expectGone('fee row', async () =>
        db
          .select({ id: tradingFees.id })
          .from(tradingFees)
          .where(inArray(tradingFees.userId, createdUserIds))
      );
      await expectGone('outbox row', async () =>
        db
          .select({ id: tradingFeeOutbox.id })
          .from(tradingFeeOutbox)
          .where(inArray(tradingFeeOutbox.userId, createdUserIds))
      );
    }
  });
  await attempt('users', async () => {
    if (createdUserIds.length) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      await expectGone('user', async () =>
        db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, createdUserIds))
      );
    }
  });
  if (cleanupFailures.length > 0) {
    // Retain every registered identity: none is confirmed deleted
    // while any section failed, so a re-run can still find them.
    throw new Error(
      `fee-accounting cleanup failed: ${cleanupFailures.join('; ')}`
    );
  }
  createdUserIds.length = 0;
  createdMarketIds.length = 0;
  createdTickers.length = 0;
  createdOrgIds.length = 0;
});

describe('A2A fee accounting against real Postgres', () => {
  it('prediction buy 1000: charged fee is fully recorded', async () => {
    const referrerId = await createUser();
    const traderId = await createUser(referrerId);
    const marketId = await createPredictionMarket();
    const before = await readFeeState(traderId, referrerId);

    const result = await FeedAgentExecutor.executeDirectly(
      'markets.buy_shares',
      { marketId, outcome: 'YES', amount: 1000 },
      traderId
    );
    // The service reports the pre-rounding fee (a float); the ledger
    // stores the cent-rounded fee (FeeService.calculateFee rounds to
    // cents), so agreement is judged to the cent.
    const charged = Number(
      Number((result as { fee?: { amount?: number } }).fee?.amount).toFixed(2)
    );
    expect(Number.isFinite(charged)).toBe(true);
    expect(charged).toBeGreaterThan(0);

    const rows = await tradeTypeRows(traderId, 'pred_buy');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    await expectDrainChangesNothingFor(traderId);
  });

  it('prediction sell: charged fee is fully recorded', async () => {
    const referrerId = await createUser();
    const traderId = await createUser(referrerId);
    const marketId = await createPredictionMarket();
    const bought = await FeedAgentExecutor.executeDirectly(
      'markets.buy_shares',
      { marketId, outcome: 'YES', amount: 1000 },
      traderId
    );
    const positionId = String(
      (bought as { position?: { id?: string } }).position?.id ?? ''
    );
    expect(positionId).not.toBe('');
    // Sell the stored share count: the returned figure is rounded and can
    // exceed the persisted position by a hair ("Insufficient shares").
    const [stored] = await db
      .select({ shares: positions.shares })
      .from(positions)
      .where(eq(positions.id, positionId));
    const shares = Number(stored?.shares ?? 0);
    expect(shares).toBeGreaterThan(0);
    const before = await readFeeState(traderId, referrerId);

    const result = await FeedAgentExecutor.executeDirectly(
      'markets.sell_shares',
      { positionId, shares },
      traderId
    );
    // The service reports the pre-rounding fee (a float); the ledger
    // stores the cent-rounded fee (FeeService.calculateFee rounds to
    // cents), so agreement is judged to the cent.
    const charged = Number(
      Number((result as { fee?: { amount?: number } }).fee?.amount).toFixed(2)
    );
    expect(Number.isFinite(charged)).toBe(true);
    expect(charged).toBeGreaterThan(0);

    const rows = await tradeTypeRows(traderId, 'pred_sell');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    await expectDrainChangesNothingFor(traderId);
  });

  it('perp open 1000: charged fee is fully recorded', async () => {
    const referrerId = await createUser();
    const traderId = await createUser(referrerId);
    const ticker = await createPerpMarket();
    const before = await readFeeState(traderId, referrerId);

    const result = await FeedAgentExecutor.executeDirectly(
      'markets.open_position',
      { ticker, side: 'long', amount: 1000, leverage: 1 },
      traderId
    );
    // The service reports the pre-rounding fee (a float); the ledger
    // stores the cent-rounded fee (FeeService.calculateFee rounds to
    // cents), so agreement is judged to the cent.
    const charged = Number(
      Number((result as { fee?: { amount?: number } }).fee?.amount).toFixed(2)
    );
    expect(Number.isFinite(charged)).toBe(true);
    expect(charged).toBeGreaterThan(0);

    const rows = await tradeTypeRows(traderId, 'perp_open');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    await expectDrainChangesNothingFor(traderId);
  });

  it('perp close: charged fee is fully recorded', async () => {
    const referrerId = await createUser();
    const traderId = await createUser(referrerId);
    const ticker = await createPerpMarket();
    const opened = await FeedAgentExecutor.executeDirectly(
      'markets.open_position',
      { ticker, side: 'long', amount: 1000, leverage: 1 },
      traderId
    );
    const positionId = String(
      (opened as { position?: { positionId?: string } }).position?.positionId ??
        ''
    );
    expect(positionId).not.toBe('');
    const before = await readFeeState(traderId, referrerId);

    const result = await FeedAgentExecutor.executeDirectly(
      'markets.close_position',
      { positionId },
      traderId
    );
    // The service reports the pre-rounding fee (a float); the ledger
    // stores the cent-rounded fee (FeeService.calculateFee rounds to
    // cents), so agreement is judged to the cent.
    const charged = Number(
      Number((result as { fee?: { amount?: number } }).fee?.amount).toFixed(2)
    );
    expect(Number.isFinite(charged)).toBe(true);
    expect(charged).toBeGreaterThan(0);

    const rows = await tradeTypeRows(traderId, 'perp_close');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    await expectDrainChangesNothingFor(traderId);
  });
});

describe('perp fee idempotent recovery against real Postgres', () => {
  type FaultState = {
    faultOnce: boolean;
    /**
     * Fault every attempt: the fee commits, but each retry observes an
     * error, so the helper exhausts and enqueues instead of recovering
     * inline — the handoff the drain must then replay under the key.
     */
    faultAlways?: boolean;
    attempts: number;
    /** operationId seen on each fee attempt, in order. */
    operationIds: string[];
  };

  /**
   * Real PerpMarketService (real Postgres, wallet, settlement, outbox)
   * with the real FeeService behind a fault-injecting wrapper. The
   * wrapper forwards the leg's `operationId`, so a retry replays the
   * same operation. When armed, the first attempt runs the real fee
   * settlement to completion and then reports failure — the post-commit
   * error a caller observes when the write committed but the response
   * was lost. The service's retry must then recover without duplicating
   * the fee, the totals, or the fund diversion.
   */
  function buildFaultableService(state: FaultState) {
    const feeProcessor = {
      async processTradingFee(params: {
        userId: string;
        amount: number;
        type: string;
        relatedId?: string;
        positionId?: string;
        operationId?: string;
      }): Promise<{ feeCharged: number; referrerPaid?: number }> {
        state.attempts += 1;
        if (params.operationId) state.operationIds.push(params.operationId);
        const result = await FeeService.processTradingFee(
          params.userId,
          params.type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
          params.amount,
          params.positionId,
          params.relatedId,
          undefined,
          params.operationId
        );
        if (state.faultAlways || state.faultOnce) {
          state.faultOnce = false;
          throw new Error('injected post-commit fee failure');
        }
        return result;
      },
    };
    return new PerpMarketService({
      settlement: createPerpSettlement(),
      db: new PerpDbAdapter(),
      wallet: createUserWalletAdapter(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      feeProcessor,
      tradingFeeOutbox: createTradingFeeOutboxAdapter(),
    });
  }

  async function openPositions(traderId: string) {
    // Closed rows stay in the table with closedAt set; open means no close.
    return db
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, traderId), isNull(perpPositions.closedAt))
      );
  }

  it('add legs: a post-commit error recovers to one fee, and a legitimate repeat add charges again', async () => {
    const traderId = await createUser();
    const ticker = await createPerpMarket();
    const state: FaultState = {
      faultOnce: false,
      attempts: 0,
      operationIds: [],
    };
    const service = buildFaultableService(state);

    const opened = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 1,
    });
    expect(opened.positionId).toBeTruthy();
    expect(opened.feePaid).toBeCloseTo(0.2, 10);
    const before = await readTraderState(traderId);

    // First add: the fee write commits, then the caller observes an error.
    // The retry replays the same operation: exactly one add fee.
    state.faultOnce = true;
    const attemptsBeforeAdd = state.attempts;
    const added = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 1,
    });
    expect(added.size).toBe(300);
    expect(added.feePaid).toBeCloseTo(0.1, 10);
    expect(state.attempts - attemptsBeforeAdd).toBe(2);

    const addRows = await tradeTypeRows(traderId, 'perp_add_to_position');
    expect(addRows).toHaveLength(1);
    expect(sum(addRows)).toBeCloseTo(0.1, 10);
    const afterFirst = await readTraderState(traderId);
    expect(afterFirst.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(
      0.1,
      10
    );
    // Fund diversion is 30% of the platform fee (referrer share is 0).
    expect(afterFirst.fund - before.fund).toBeCloseTo(0.03, 6);
    // Added margin 100 + fee 0.10 debited.
    expect(afterFirst.balance).toBeCloseTo(before.balance - 100 - 0.1, 6);
    const positions = await openPositions(traderId);
    expect(positions).toHaveLength(1);
    expect(Number(positions[0]?.size)).toBe(300);
    await expectDrainChangesNothingFor(traderId);

    // Legitimate repeat leg: same position, type and amount — a
    // (position, type) key alone could not tell this from the retry, but
    // the fresh operation id means it must charge again.
    const addedAgain = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 1,
    });
    expect(addedAgain.size).toBe(400);
    const addRows2 = await tradeTypeRows(traderId, 'perp_add_to_position');
    expect(addRows2).toHaveLength(2);
    expect(sum(addRows2)).toBeCloseTo(0.2, 10);
    const afterSecond = await readTraderState(traderId);
    expect(afterSecond.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(
      0.2,
      10
    );
    expect(afterSecond.fund - before.fund).toBeCloseTo(0.06, 6);
    expect(afterSecond.balance).toBeCloseTo(before.balance - 200 - 0.2, 6);
    await expectDrainChangesNothingFor(traderId);
  });

  it('equal-size opposite close: a post-commit error recovers to one close fee', async () => {
    const traderId = await createUser();
    const ticker = await createPerpMarket();
    const state: FaultState = {
      faultOnce: false,
      attempts: 0,
      operationIds: [],
    };
    const service = buildFaultableService(state);

    const opened = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 1,
    });
    expect(opened.positionId).toBeTruthy();
    const before = await readTraderState(traderId);

    // Opposite-side short 200 against long 200 closes the position in
    // full (reduceOrFlipPosition delegates to closePosition).
    state.faultOnce = true;
    const attemptsBeforeClose = state.attempts;
    const closed = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'short',
      size: 200,
      leverage: 1,
    });
    expect(closed.rebalanceType).toBe('close');
    expect(closed.feePaid).toBeCloseTo(0.2, 10);
    expect(state.attempts - attemptsBeforeClose).toBe(2);

    const closeRows = await tradeTypeRows(traderId, 'perp_close');
    expect(closeRows).toHaveLength(1);
    expect(sum(closeRows)).toBeCloseTo(0.2, 10);
    const after = await readTraderState(traderId);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(0.2, 10);
    expect(after.fund - before.fund).toBeCloseTo(0.06, 6);
    // The close fills at the synthetic execution price (below spot for a
    // long sell), so realised PnL is negative. The reported realised PnL
    // is cent-rounded while the wallet moved by the full-precision figure,
    // so the balance is asserted exactly against the service-reported
    // balance and to the cent against the reported settlement fields.
    assertFiniteNumber(closed.balance);
    expect(after.balance).toBe(closed.balance);
    expect(after.balance).toBeCloseTo(
      before.balance +
        (closed.marginPaid ?? 0) +
        (closed.realizedPnL ?? 0) -
        closed.feePaid,
      2
    );
    const positions = await openPositions(traderId);
    expect(positions).toHaveLength(0);
    await expectDrainChangesNothingFor(traderId);
  });

  it('flip: a post-commit error on one leg recovers both legs to one fee each', async () => {
    const traderId = await createUser();
    const ticker = await createPerpMarket();
    const state: FaultState = {
      faultOnce: false,
      attempts: 0,
      operationIds: [],
    };
    const service = buildFaultableService(state);

    const opened = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 1,
    });
    expect(opened.positionId).toBeTruthy();
    const before = await readTraderState(traderId);

    // Opposite-side short 300 against long 200 flips to short 100. The
    // two legs run concurrently; exactly one of them observes the
    // post-commit error and retries, so three fee attempts in total.
    state.faultOnce = true;
    const attemptsBeforeFlip = state.attempts;
    const flipped = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'short',
      size: 300,
      leverage: 1,
    });
    expect(flipped.rebalanceType).toBe('flip');
    expect(flipped.side).toBe('short');
    expect(flipped.size).toBe(100);
    expect(flipped.feePaid).toBeCloseTo(0.3, 10);
    expect(state.attempts - attemptsBeforeFlip).toBe(3);

    const closeRows = await tradeTypeRows(traderId, 'perp_close');
    expect(closeRows).toHaveLength(1);
    expect(sum(closeRows)).toBeCloseTo(0.2, 10);
    const flipRows = await tradeTypeRows(traderId, 'perp_flip_position');
    expect(flipRows).toHaveLength(1);
    expect(sum(flipRows)).toBeCloseTo(0.1, 10);
    const after = await readTraderState(traderId);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(0.3, 10);
    expect(after.fund - before.fund).toBeCloseTo(0.09, 6);
    // Close leg returns margin 200 + realised PnL - close fee; flip leg
    // costs new margin 100 + flip fee. The reported realised PnL is
    // cent-rounded while the wallet moved by the full-precision figure,
    // so the balance is asserted exactly against the service-reported
    // balance and to the cent against the reported fields.
    assertFiniteNumber(flipped.balance);
    expect(after.balance).toBe(flipped.balance);
    expect(after.balance).toBeCloseTo(
      before.balance +
        200 +
        (flipped.realizedPnL ?? 0) -
        flipped.feePaid -
        (flipped.marginPaid ?? 0),
      2
    );
    const positions = await openPositions(traderId);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.side).toBe('short');
    expect(Number(positions[0]?.size)).toBe(100);
    await expectDrainChangesNothingFor(traderId);
  });

  it('exhaustion: a fee that commits but fails every retry is queued under its key and drains exactly once', async () => {
    const traderId = await createUser();
    const ticker = await createPerpMarket();
    const state: FaultState = {
      faultOnce: false,
      faultAlways: true,
      attempts: 0,
      operationIds: [],
    };
    const service = buildFaultableService(state);

    const before = await readTraderState(traderId);
    const opened = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 1,
    });
    expect(opened.positionId).toBeTruthy();
    expect(opened.feePaid).toBeCloseTo(0.2, 10);
    // All three inline attempts ran the real settlement (the first one
    // committed) and then observed the injected error.
    expect(state.attempts).toBe(3);
    expect(new Set(state.operationIds)).toHaveLength(1);

    // Exactly one fee row: the retries replayed under the same key.
    const openRows = await tradeTypeRows(traderId, 'perp_open');
    expect(openRows).toHaveLength(1);
    expect(sum(openRows)).toBeCloseTo(0.2, 10);
    const afterOpen = await readTraderState(traderId);
    expect(afterOpen.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(0.2, 10);
    expect(afterOpen.fund - before.fund).toBeCloseTo(0.06, 6);
    // Margin 200 + fee 0.20 debited even though the fee recording
    // faulted on every attempt.
    expect(afterOpen.balance).toBeCloseTo(before.balance - 200 - 0.2, 6);

    // The exhausted intent is queued — under the SAME key, so the drain
    // replays it instead of charging a second fee.
    const queued = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, traderId));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.idempotencyKey).toBe(state.operationIds[0]);

    // Two concurrent drains still settle the intent exactly once.
    const [first, second] = await Promise.all([
      drainTradingFeeOutboxBatch(),
      drainTradingFeeOutboxBatch(),
    ]);
    expect(first.processed + second.processed).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    const third = await drainTradingFeeOutboxBatch();
    expect(third.processed).toBe(0);

    const afterDrain = await readTraderState(traderId);
    expect(await tradeTypeRows(traderId, 'perp_open')).toHaveLength(1);
    expect(afterDrain.totalFeesPaid).toBe(afterOpen.totalFeesPaid);
    expect(afterDrain.fund).toBe(afterOpen.fund);
    expect(afterDrain.balance).toBe(afterOpen.balance);
  });

  it('drain replay: an outbox row whose key already settled does not charge again', async () => {
    const traderId = await createUser();
    const ticker = await createPerpMarket();
    const state: FaultState = {
      faultOnce: false,
      attempts: 0,
      operationIds: [],
    };
    const service = buildFaultableService(state);

    const opened = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 1,
    });
    expect(opened.positionId).toBeTruthy();
    const before = await readTraderState(traderId);

    // One post-commit error on the add leg: the retry replays, so
    // exactly one add fee row exists under the leg's key.
    state.faultOnce = true;
    const attemptsBeforeAdd = state.attempts;
    const added = await service.openPosition({
      userId: traderId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 1,
    });
    expect(added.feePaid).toBeCloseTo(0.1, 10);
    expect(state.attempts - attemptsBeforeAdd).toBe(2);
    const addKeys = state.operationIds.slice(attemptsBeforeAdd);
    expect(new Set(addKeys)).toHaveLength(1);
    const key = addKeys[0];
    expect(key).toBeTruthy();
    const addRows = await tradeTypeRows(traderId, 'perp_add_to_position');
    expect(addRows).toHaveLength(1);
    expect(sum(addRows)).toBeCloseTo(0.1, 10);
    const afterAdd = await readTraderState(traderId);
    expect(afterAdd.totalFeesPaid - before.totalFeesPaid).toBeCloseTo(0.1, 10);

    // Simulate the both-fail handoff: the fee committed, but the replay
    // lookup also failed on every retry, so the intent was enqueued
    // under the same key. The drain must replay it, not charge again.
    await db.insert(tradingFeeOutbox).values({
      id: await generateSnowflakeId(),
      userId: traderId,
      tradeType: 'perp_add_to_position',
      tradeAmount: '100',
      tradeId: opened.positionId,
      marketId: ticker,
      idempotencyKey: key,
      lastError: 'simulated both-fail enqueue',
    });
    const drained = await drainTradingFeeOutboxBatch();
    expect(drained.processed).toBe(1);
    expect(drained.failed).toBe(0);
    const afterDrain = await readTraderState(traderId);
    expect(await tradeTypeRows(traderId, 'perp_add_to_position')).toHaveLength(
      1
    );
    expect(afterDrain.totalFeesPaid).toBe(afterAdd.totalFeesPaid);
    expect(afterDrain.fund).toBe(afterAdd.fund);
    expect(afterDrain.balance).toBe(afterAdd.balance);
    const again = await drainTradingFeeOutboxBatch();
    expect(again.processed).toBe(0);
  });
});
