/**
 * PRD §9.1 (Trading fee) and MVP Phase 6: each execution must reconcile
 * its charge with the fee ledger. MCP is the supported trade protocol
 * (PRD §8), so its perp tools must keep the fee recovery that the A2A,
 * REST and plugin perp paths already have: the leg's `operationId` on
 * every fee attempt, and the durable trading-fee outbox when the
 * retries exhaust.
 *
 * Real MCP handlers (`executeOpenPosition`, `executeClosePosition`), real
 * PerpMarketService, real FeeService and real Postgres. The only fault is
 * injected at the fee boundary (`FeeService.processTradingFee`), as in
 * a2a-executor-fee-accounting.integration.test.ts.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  gameConfigs,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  sql,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { FeeService, STABILITY_FUND_CONFIG } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { drainTradingFeeOutboxBatch } from '../../engine/src/services/trading-fee-outbox';
import {
  executeClosePosition,
  executeOpenPosition,
} from '../../mcp/src/handlers/tool-handlers';

const databaseURL = process.env.DATABASE_URL ?? '';
const database = new URL(databaseURL);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseURL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');

const createdUserIds: string[] = [];
const createdTickers: string[] = [];
const createdOrgIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `mcp-fee-${userId.slice(-10)}`,
    profileComplete: true,
    virtualBalance: '10000',
    totalDeposited: '10000',
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function createPerpMarket(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const ticker = `MCPFEE${suffix}`.toUpperCase();
  const orgId = `mcp-fee-org-${suffix}`;
  const now = new Date();
  await db.insert(organizationState).values({
    id: orgId,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: now,
  });
  createdOrgIds.push(orgId);
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'MCP Fee Recovery Test Org',
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

const agentFor = (userId: string) => ({ agentId: 'mcp-fee-agent', userId });

async function feeRows(userId: string, tradeType: string) {
  const rows = await db
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, userId));
  return rows.filter((row) => row.tradeType === tradeType);
}

async function outboxRows(userId: string) {
  return db
    .select()
    .from(tradingFeeOutbox)
    .where(eq(tradingFeeOutbox.userId, userId));
}

async function totalFeesPaid(userId: string): Promise<number> {
  const [row] = await db
    .select({ totalFeesPaid: users.totalFeesPaid })
    .from(users)
    .where(eq(users.id, userId));
  return Number(row?.totalFeesPaid ?? 0);
}

/**
 * The charged fee of an MCP trade result, judged to the cent like the
 * ledger (FeeService rounds up to cents). The results are untyped JSON
 * records, so a missing fee fails the test instead of reading as zero.
 */
function chargedFee(result: { fee?: unknown }): number {
  const amount = (result.fee as { amount?: unknown } | undefined)?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new Error('trade result has no fee amount');
  return Number(amount.toFixed(2));
}

type Fault = 'after-commit-always' | 'after-commit-once' | 'before-commit';

/**
 * Wrap the real FeeService.processTradingFee. `after-commit-*` runs the
 * real write and then reports failure (the response was lost after the
 * commit); `before-commit` fails without writing.
 */
function injectFeeFault(fault: Fault) {
  const real = FeeService.processTradingFee.bind(FeeService);
  let armed = true;
  return spyOn(FeeService, 'processTradingFee').mockImplementation(
    async (...args: Parameters<typeof FeeService.processTradingFee>) => {
      if (fault === 'before-commit') {
        throw new Error('injected fee failure before commit');
      }
      const result = await real(...args);
      if (fault === 'after-commit-always' || armed) {
        armed = false;
        throw new Error('injected post-commit fee failure');
      }
      return result;
    }
  );
}

let spy: ReturnType<typeof injectFeeFault> | undefined;
afterEach(() => {
  spy?.mockRestore();
  spy = undefined;
});

afterAll(async () => {
  if (createdUserIds.length) {
    const [agg] = await db
      .select({
        platformTotal: sql<string>`COALESCE(SUM(${tradingFees.platformFee}::numeric), 0)`,
      })
      .from(tradingFees)
      .where(inArray(tradingFees.userId, createdUserIds));
    const ownDiversion =
      Number(agg?.platformTotal ?? 0) *
      STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE;
    if (ownDiversion > 0) {
      await db
        .update(gameConfigs)
        .set({
          value: sql`to_json(COALESCE((${gameConfigs.value} #>> '{}')::numeric, 0) - ${ownDiversion})`,
          updatedAt: new Date(),
        })
        .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));
    }
  }
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
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('MCP perp fee recovery against real Postgres', () => {
  it('open_position: a fee write that fails every retry is kept in the outbox and drains to the charged fee', async () => {
    const userId = await createUser();
    const ticker = await createPerpMarket();

    spy = injectFeeFault('before-commit');
    const result = await executeOpenPosition(agentFor(userId), {
      ticker,
      side: 'LONG',
      amount: 1000,
      leverage: 1,
    });
    spy.mockRestore();
    spy = undefined;

    const fee = chargedFee(result);
    expect(fee).toBeGreaterThan(0);
    expect(await feeRows(userId, 'perp_open')).toHaveLength(0);
    expect(await outboxRows(userId)).toHaveLength(1);

    await drainTradingFeeOutboxBatch();
    const rows = await feeRows(userId, 'perp_open');
    expect(rows.map((row) => Number(row.feeAmount))).toEqual([fee]);
    expect(await totalFeesPaid(userId)).toBe(fee);
    expect(await outboxRows(userId)).toHaveLength(0);
  });

  it('open_position: a fee that commits but fails every retry is recorded once, also after the drain', async () => {
    const userId = await createUser();
    const ticker = await createPerpMarket();

    spy = injectFeeFault('after-commit-always');
    const result = await executeOpenPosition(agentFor(userId), {
      ticker,
      side: 'LONG',
      amount: 1000,
      leverage: 1,
    });
    spy.mockRestore();
    spy = undefined;

    const fee = chargedFee(result);
    expect(await feeRows(userId, 'perp_open')).toHaveLength(1);
    expect(await outboxRows(userId)).toHaveLength(1);

    await drainTradingFeeOutboxBatch();
    const rows = await feeRows(userId, 'perp_open');
    expect(rows.map((row) => Number(row.feeAmount))).toEqual([fee]);
    expect(await totalFeesPaid(userId)).toBe(fee);
    expect(await outboxRows(userId)).toHaveLength(0);
  });

  it('close_position: a post-commit fee error recovers to one close fee', async () => {
    const userId = await createUser();
    const ticker = await createPerpMarket();
    const opened = await executeOpenPosition(agentFor(userId), {
      ticker,
      side: 'LONG',
      amount: 1000,
      leverage: 1,
    });
    const positionId = (opened.position as { positionId?: unknown } | undefined)
      ?.positionId;
    if (typeof positionId !== 'string') throw new Error('position id missing');
    const paidAfterOpen = await totalFeesPaid(userId);

    spy = injectFeeFault('after-commit-once');
    const closed = await executeClosePosition(agentFor(userId), {
      positionId,
    });
    spy.mockRestore();
    spy = undefined;

    const fee = chargedFee(closed);
    expect(fee).toBeGreaterThan(0);
    const rows = await feeRows(userId, 'perp_close');
    expect(rows.map((row) => Number(row.feeAmount))).toEqual([fee]);
    expect(
      Number(((await totalFeesPaid(userId)) - paidAfterOpen).toFixed(2))
    ).toBe(fee);
    expect(await outboxRows(userId)).toHaveLength(0);
  });
});
