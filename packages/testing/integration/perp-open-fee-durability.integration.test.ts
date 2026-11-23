/** PRD §§9.1/9.3/9.6, MVP phase 6: plugin fees are recorded or durably queued. */
import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import {
  runIsolatedPluginPerpFeeCases,
  verifyPluginPerpFeeChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_PLUGIN_PERP_FEE_CHILD) {
  test('runs all six perp fee durability and plugin cases in a leased fresh database', async () => {
    await runIsolatedPluginPerpFeeCases();
  }, 300_000);
} else {
  // No application client may be imported before positive child ownership.
  await verifyPluginPerpFeeChildLease();
  const leaseFile = process.env.FEED_PLUGIN_PERP_FEE_LEASE_FILE;
  assert.ok(leaseFile, 'Verified child lease file is required');
  const receiptPath = join(dirname(leaseFile), 'fixture-receipts.jsonl');
  writeFileSync(receiptPath, '', { flag: 'wx', mode: 0o600 });
  // Real handlers receive explicit structured action state. This is component
  // accounting evidence; no inference or model-selected action is claimed.
  const { PerpDbAdapter, PerpMarketService } = await import(
    '@feed/core/markets/perps'
  );
  const {
    balanceTransactions,
    closeDatabase,
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    sql,
    tradingFeeOutbox,
    tradingFees,
    users,
  } = await import('@feed/db');
  const {
    createPerpSettlement,
    createTradingFeeOutboxAdapter,
    createUserWalletAdapter,
    FEE_CONFIG,
    FeeService,
  } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { openPerpAction } = await import(
    '../../../packages/agents/src/plugins/plugin-agent-core/src/actions/open-perp'
  );
  const { closePerpAction } = await import(
    '../../../packages/agents/src/plugins/plugin-agent-core/src/actions/close-perp'
  );
  const { z } = await import('zod');
  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  type ReturnedRow = { id: string; canonical: string };
  function remember(table: string, rows: ReturnedRow[]) {
    // Persist actual full physical RETURNING rows before any count assertion.
    for (const row of rows)
      appendFileSync(receiptPath, JSON.stringify({ table, ...row }) + '\n', {
        mode: 0o600,
      });
  }
  async function createTrader(
    id: string,
    username: string,
    referredBy?: string
  ) {
    const now = new Date();
    const rows = await db
      .insert(users)
      .values({
        id,
        username,
        virtualBalance: '10000',
        totalDeposited: '10000',
        referredBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      });
    remember('User', rows);
    expect(rows).toHaveLength(1);
  }
  async function createFeeMarket(ticker: string) {
    const now = new Date();
    const states = await db
      .insert(organizationState)
      .values({ id: ticker, currentPrice: 100, basePrice: 100, updatedAt: now })
      .returning({
        id: organizationState.id,
        canonical: sql<string>`to_jsonb(${organizationState})::text`,
      });
    remember('OrganizationState', states);
    expect(states).toHaveLength(1);
    const snapshots = await db
      .insert(perpMarketSnapshots)
      .values({
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
          nextFundingTime: now.toISOString(),
        },
      })
      .returning({
        id: perpMarketSnapshots.ticker,
        canonical: sql<string>`to_jsonb(${perpMarketSnapshots})::text`,
      });
    remember('PerpMarketSnapshot', snapshots);
    expect(snapshots).toHaveLength(1);
  }
  const actionState = (actionParams: Record<string, string | number>) =>
    ({ data: { actionParams } }) as unknown as State;
  const actionMessage = {} as Memory;
  const openedShape = z.object({
    positionId: z.string().min(1),
    ticker: z.string(),
    size: z.number(),
    leverage: z.number(),
    entryPrice: z.number(),
  });
  const closedShape = z.object({
    positionId: z.string(),
    closedAmount: z.number(),
    remainingSize: z.number(),
    pnl: z.number(),
  });

  async function assertWalletLedger(userId: string) {
    const [result] = await db.execute<{ balanced: boolean }>(sql`
      SELECT u."virtualBalance" = 10000 + COALESCE((
        SELECT SUM(b.amount) FROM public."BalanceTransaction" b WHERE b."userId"=u.id), 0) AS balanced
      FROM public."User" u WHERE u.id=${userId}`);
    expect(result?.balanced).toBe(true);
  }
  async function recordObservedRows(
    table:
      | 'TradingFee'
      | 'TradingFeeOutbox'
      | 'PerpPosition'
      | 'BalanceTransaction',
    userId: string
  ) {
    const rows = await db.execute<ReturnedRow>(sql`
      SELECT t.id,to_jsonb(t)::text AS canonical FROM public.${sql.identifier(table)} t
      WHERE t."userId"=${userId} ORDER BY t.id`);
    remember(table, Array.from(rows));
  }

  // All rows remain in this new exclusive child dataset. There is no row-level
  // DELETE, global drain, clock override or manual cleanup. The reviewed lifecycle
  // retains failed children and is the only owner allowed to remove a passed one.
  for (const side of ['long', 'short'] as const) {
    for (const outage of ['transient', 'persistent'] as const) {
      test(`${side}: ${outage} fee failure has completed or queued fee work before open returns`, async () => {
        const userId = await generateSnowflakeId(),
          ticker = `FEEOPEN${userId}`;
        let attempts = 0;
        await createTrader(userId, `fee-open-${userId}`);
        await createFeeMarket(ticker);
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
                params.relatedId,
                undefined,
                params.operationId
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
      });
    }
  }

  test('plugin OPEN and CLOSE return with actual keyed fee accounting and no referral payment', async () => {
    const referrerId = await generateSnowflakeId();
    const userId = await generateSnowflakeId();
    const ticker = `FEEPLUGIN${userId}`;
    await createTrader(referrerId, `plugin-referrer-${referrerId}`);
    await createTrader(userId, `plugin-trader-${userId}`, referrerId);
    await createFeeMarket(ticker);
    const [referrerBefore] = await db
      .select({ canonical: sql<string>`to_jsonb(${users})::text` })
      .from(users)
      .where(eq(users.id, referrerId));
    expect(referrerBefore).toBeDefined();
    const runtime = { agentId: userId } as IAgentRuntime;
    const opened = await openPerpAction.handler(
      runtime,
      actionMessage,
      actionState({ ticker, side: 'LONG', amount: 100, leverage: 5 })
    );
    expect(opened?.success).toBe(true);
    const trade = openedShape.parse(opened?.data);
    expect(trade.size).toBe(500);
    const [afterOpen] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(Number(afterOpen!.virtualBalance)).toBe(9899.5);
    expect(Number(afterOpen!.totalFeesPaid)).toBe(0.5);
    const openingLedger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    expect(
      openingLedger.filter((row) => row.type === 'perp_open')
    ).toHaveLength(1);
    expect(
      Number(openingLedger.find((row) => row.type === 'perp_open')!.amount)
    ).toBe(-100.5);
    let fees = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(fees).toHaveLength(1);
    expect(fees[0]!.tradeType).toBe('perp_open');
    expect(Number(fees[0]!.feeAmount)).toBe(0.5);
    expect(fees[0]!.idempotencyKey).toBeString();
    const closed = await closePerpAction.handler(
      runtime,
      actionMessage,
      actionState({ positionId: trade.positionId })
    );
    expect(closed?.success).toBe(true);
    const exit = closedShape.parse(closed?.data);
    expect(exit.positionId).toBe(trade.positionId);
    expect(exit.closedAmount).toBe(500);
    expect(exit.remainingSize).toBe(0);
    fees = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(fees).toHaveLength(2);
    expect(fees.map((row) => row.tradeType).sort()).toEqual([
      'perp_close',
      'perp_open',
    ]);
    expect(new Set(fees.map((row) => row.idempotencyKey)).size).toBe(2);
    for (const fee of fees) {
      expect(fee.idempotencyKey).toBeString();
      expect(fee.idempotencyKey!.length).toBeGreaterThan(0);
      expect(fee.tradeId).toBe(trade.positionId);
      expect(fee.marketId).toBe(ticker);
      expect(Number(fee.feeAmount)).toBe(0.5);
      expect(Number(fee.referrerFee)).toBe(0);
      expect(fee.referrerId).toBeNull();
    }
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    expect(Number(owner!.totalFeesPaid)).toBe(1);
    const queued = await db
      .select()
      .from(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    expect(queued).toHaveLength(0);
    const [position] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, trade.positionId));
    expect(position).toBeDefined();
    expect(position!.closedAt).not.toBeNull();
    const [referrerAfter] = await db
      .select({ canonical: sql<string>`to_jsonb(${users})::text` })
      .from(users)
      .where(eq(users.id, referrerId));
    expect(referrerAfter).toEqual(referrerBefore);
    const referralLedger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, referrerId));
    expect(referralLedger).toHaveLength(0);
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    expect(ledger.filter((row) => row.type === 'perp_open')).toHaveLength(1);
    expect(ledger.filter((row) => row.type === 'perp_close')).toHaveLength(1);
    await assertWalletLedger(userId);
    for (const table of [
      'TradingFee',
      'TradingFeeOutbox',
      'PerpPosition',
      'BalanceTransaction',
    ] as const)
      await recordObservedRows(table, userId);
  });

  test('plugin OPEN and CLOSE return success with their own durable fee intents during an outage', async () => {
    const userId = await generateSnowflakeId();
    const ticker = `FEEPLUGINOUT${userId}`;
    await createTrader(userId, `plugin-outage-${userId}`);
    await createFeeMarket(ticker);
    const runtime = { agentId: userId } as IAgentRuntime;
    const original = FeeService.processTradingFee;
    let attempts = 0;
    try {
      // Only the fee-ledger call fails. Wallet/position settlement, plugin
      // handlers, the shared adapter and durable outbox are the real code.
      FeeService.processTradingFee = async () => {
        attempts++;
        throw new Error('Owned plugin fee-ledger outage');
      };
      const opened = await openPerpAction.handler(
        runtime,
        actionMessage,
        actionState({ ticker, side: 'SHORT', amount: 100, leverage: 5 })
      );
      expect(opened?.success).toBe(true);
      const trade = openedShape.parse(opened?.data);
      const [afterOpen] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(Number(afterOpen!.virtualBalance)).toBe(9899.5);
      expect(Number(afterOpen!.totalFeesPaid)).toBe(0);
      let queued = await db
        .select()
        .from(tradingFeeOutbox)
        .where(eq(tradingFeeOutbox.userId, userId));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.tradeType).toBe('perp_open');
      expect(queued[0]!.tradeId).toBe(trade.positionId);
      expect(queued[0]!.idempotencyKey).toBeString();
      expect(attempts).toBe(3);
      const closed = await closePerpAction.handler(
        runtime,
        actionMessage,
        actionState({ positionId: trade.positionId })
      );
      expect(closed?.success).toBe(true);
      const exit = closedShape.parse(closed?.data);
      expect(exit.remainingSize).toBe(0);
      expect(exit.closedAmount).toBe(500);
      queued = await db
        .select()
        .from(tradingFeeOutbox)
        .where(eq(tradingFeeOutbox.userId, userId));
      expect(queued).toHaveLength(2);
      expect(queued.map((row) => row.tradeType).sort()).toEqual([
        'perp_close',
        'perp_open',
      ]);
      expect(new Set(queued.map((row) => row.idempotencyKey)).size).toBe(2);
      for (const intent of queued) {
        expect(intent.tradeId).toBe(trade.positionId);
        expect(intent.marketId).toBe(ticker);
        expect(Number(intent.tradeAmount)).toBe(500);
        expect(intent.idempotencyKey).toBeString();
        expect(intent.idempotencyKey!.length).toBeGreaterThan(0);
      }
      expect(attempts).toBe(6);
      const charged = await db
        .select()
        .from(tradingFees)
        .where(eq(tradingFees.userId, userId));
      expect(charged).toHaveLength(0);
      const [owner] = await db.select().from(users).where(eq(users.id, userId));
      expect(Number(owner!.totalFeesPaid)).toBe(0);
      const [position] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, trade.positionId));
      expect(position).toBeDefined();
      expect(position!.closedAt).not.toBeNull();
      const ledger = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      expect(ledger.filter((row) => row.type === 'perp_open')).toHaveLength(1);
      expect(ledger.filter((row) => row.type === 'perp_close')).toHaveLength(1);
      await assertWalletLedger(userId);
      for (const table of [
        'TradingFee',
        'TradingFeeOutbox',
        'PerpPosition',
        'BalanceTransaction',
      ] as const)
        await recordObservedRows(table, userId);
    } finally {
      FeeService.processTradingFee = original;
    }
  });
}
