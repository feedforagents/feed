/**
 * PRD §9.1 (Trading fee) and MVP Phase 6: each execution must reconcile
 * its charge with the fee ledger. MCP is the supported trade protocol
 * (PRD §8), so its perp tools must keep the fee recovery that the A2A,
 * REST and plugin perp paths already have: the leg's `operationId` on
 * every fee attempt, and the durable trading-fee outbox when the
 * retries exhaust.
 *
 * Real MCP handlers (`executeOpenPosition`, `executeClosePosition`), real
 * PerpMarketService, real FeeService, the real outbox drain and real
 * Postgres. The only fault is injected at the fee boundary
 * (`FeeService.processTradingFee`), as in
 * a2a-executor-fee-accounting.integration.test.ts. The cases run in a
 * positively leased fresh database, so the drain sees only this suite's
 * outbox rows and the dropped database owns all cleanup.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  runIsolatedMcpPerpFeeCases,
  verifyMcpPerpFeeChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_MCP_PERP_FEE_CHILD) {
  it('runs the three MCP perp fee recovery cases in a leased fresh database', async () => {
    await runIsolatedMcpPerpFeeCases();
  }, 300_000);
} else {
  // No application client may be imported before positive child ownership.
  await verifyMcpPerpFeeChildLease();
  const {
    closeDatabase,
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    tradingFeeOutbox,
    tradingFees,
    users,
  } = await import('@feed/db');
  const { FeeService } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { drainTradingFeeOutboxBatch } = await import(
    '../../engine/src/services/trading-fee-outbox'
  );
  const { executeClosePosition, executeOpenPosition } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );
  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

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
      const positionId = (
        opened.position as { positionId?: unknown } | undefined
      )?.positionId;
      if (typeof positionId !== 'string')
        throw new Error('position id missing');
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
}
