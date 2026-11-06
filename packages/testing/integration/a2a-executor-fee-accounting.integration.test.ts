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
 * (the referrer share is the current canonical config; #1585 proposes
 * removing it, but until it merges the wired processor must pay what
 * every other surface pays.)
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  positions,
  tradingFees,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

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
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'Fee Accounting Test Org',
    currentPrice: 100,
    high24h: 100,
    low24h: 100,
    fundingRate: {
      ticker,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
  createdTickers.push(ticker);
  createdOrgIds.push(orgId);
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

function sum(rows: { feeAmount: string }[]): number {
  return rows.reduce((total, row) => total + Number(row.feeAmount), 0);
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

// Perp close settles its fee via fire-and-forget `processFeeWithRetry`
// (existing PerpMarketService behavior on every surface, not A2A-specific),
// so the row can land just after closePosition returns. Poll briefly
// instead of asserting on a race.
async function waitForFeeRows(
  traderId: string,
  tradeType: string,
  timeoutMs = 5000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await tradeTypeRows(traderId, tradeType);
    if (rows.length > 0) return rows;
    if (Date.now() >= deadline) return rows;
    await Bun.sleep(100);
  }
}

afterAll(async () => {
  if (createdTickers.length) {
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.ticker, createdTickers));
    await db
      .delete(perpMarketSnapshots)
      .where(inArray(perpMarketSnapshots.ticker, createdTickers));
  }
  if (createdOrgIds.length) {
    await db
      .delete(organizationState)
      .where(inArray(organizationState.id, createdOrgIds));
  }
  if (createdMarketIds.length) {
    await db
      .delete(positions)
      .where(inArray(positions.marketId, createdMarketIds));
    await db.delete(markets).where(inArray(markets.id, createdMarketIds));
  }
  if (createdUserIds.length) {
    await db
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, createdUserIds));
    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
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

    const rows = await waitForFeeRows(traderId, 'pred_buy');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
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

    const rows = await waitForFeeRows(traderId, 'pred_sell');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
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

    const rows = await waitForFeeRows(traderId, 'perp_open');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
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

    const rows = await waitForFeeRows(traderId, 'perp_close');
    const after = await readFeeState(traderId, referrerId);
    expect(sum(rows)).toBe(charged);
    expect(after.totalFeesPaid - before.totalFeesPaid).toBe(charged);
    expect(sumReferrer(rows)).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
    expect(after.referrerEarned - before.referrerEarned).toBe(
      Number((charged * FEE_CONFIG.REFERRER_SHARE).toFixed(2))
    );
  });
});
