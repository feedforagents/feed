/**
 * Perp open fee failure: a fee-ledger failure after the trade commits must
 * not turn the committed trade into a reported failure.
 *
 * Regression test for feed #1586 (SYMBaiEX change request): on the old code
 * `openPosition` awaited `FeeService.processTradingFee` directly after the
 * settlement transaction had committed, so a fee-ledger error surfaced as
 * an exception while the 200-notional position and the cash debit were
 * already committed — and an agent retry would open a second position.
 * The fresh-open path was fixed first; the follow-up review found the same
 * boundary on close / add-to-position / reduce / flip, which fired the fee
 * call and returned success before the fee intent was durable. All paths
 * now await `processFeeWithRetry` (+ outbox), so the fee intent is durable
 * (settled inline or persisted to the outbox) before the operation
 * resolves: the A2A request path has no waitUntil/after to finish a detached
 * promise if the serverless invocation ends first. `processFeeWithRetry`
 * never throws, so awaiting it cannot fail the committed trade.
 *
 * Round 3 adds the operation identity: each fee leg is charged under one
 * `operationId`, reused across that leg's retries and fresh for the next
 * leg, so the real FeeService can replay a retry of the same operation
 * instead of inserting a second fee row. A (position, type) pair alone
 * cannot tell a retry from a legitimate repeat leg.
 *
 * Mirrors the in-memory fakes in perp-open-fee-consistency.test.ts so the
 * test runs without Postgres.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type PerpDbPort,
  type PerpMarketRecord,
  PerpMarketService,
  type PerpPositionRecord,
  type WalletPort,
} from '@feed/core/markets/perps';
import { FEE_CONFIG } from '@feed/engine';

const feeConfig = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

class ThrowingFeeProcessor {
  calls: Array<{ amount: number; type: string }> = [];
  /** One entry per fee attempt, in call order. */
  operationIds: Array<string | undefined> = [];

  async processTradingFee(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
    operationId?: string;
  }): Promise<{ feeCharged: number; referrerPaid?: number }> {
    this.calls.push({ amount: params.amount, type: params.type });
    this.operationIds.push(params.operationId);
    throw new Error('injected fee ledger failure');
  }
}

/** Fails `failTimes` attempts, then settles like the real FeeService. */
class FlakyFeeProcessor {
  calls = 0;
  operationIds: Array<string | undefined> = [];
  constructor(private failTimes: number) {}

  async processTradingFee(_params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
    operationId?: string;
  }): Promise<{ feeCharged: number; referrerPaid?: number }> {
    this.calls += 1;
    this.operationIds.push(_params.operationId);
    if (this.calls <= this.failTimes) {
      throw new Error('injected fee ledger failure');
    }
    return { feeCharged: 0.2, referrerPaid: 0 };
  }
}

/** Each fee leg retries under one operation id; distinct legs differ. */
function expectOperationIds(
  processor: ThrowingFeeProcessor | FlakyFeeProcessor,
  expectedLegs: number
) {
  const ids = processor.operationIds;
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(id).toBeTruthy();
  expect(new Set(ids)).toHaveLength(expectedLegs);
}

class RecordingOutbox {
  calls: Array<{
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
    operationId?: string;
  }> = [];

  async enqueue(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
    operationId?: string;
    lastError?: string;
  }): Promise<void> {
    this.calls.push({ ...params });
  }
}

class ThrowingOutbox extends RecordingOutbox {
  override async enqueue(_params: {
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
    operationId?: string;
    lastError?: string;
  }): Promise<void> {
    throw new Error('injected outbox failure');
  }
}

class InMemoryWallet implements WalletPort {
  private balances = new Map<string, number>();

  constructor(private defaultBalance = 10_000) {}

  async debit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
    reason: string;
  }): Promise<void> {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    if (balance < amount) throw new Error('Insufficient funds');
    this.balances.set(userId, balance - amount);
  }

  async credit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
    reason: string;
  }): Promise<void> {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, balance + amount);
  }

  async recordPnL(): Promise<void> {}

  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class InMemoryPerpDb implements PerpDbPort {
  private markets = new Map<string, PerpMarketRecord>();
  private positions = new Map<string, PerpPositionRecord>();
  private idCounter = 1;

  constructor(initialMarkets: PerpMarketRecord[]) {
    initialMarkets.forEach((m) => this.markets.set(m.ticker, { ...m }));
  }

  async listMarkets(): Promise<PerpMarketRecord[]> {
    return Array.from(this.markets.values()).map((m) => ({ ...m }));
  }

  async countMarkets(): Promise<number> {
    return this.markets.size;
  }

  async listOpenPositions(): Promise<PerpPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => !p.closedAt)
      .map((p) => ({ ...p }));
  }

  async getPositionById(id: string): Promise<PerpPositionRecord | null> {
    const pos = this.positions.get(id);
    return pos ? { ...pos } : null;
  }

  async getOpenPositionsByUser(userId: string): Promise<PerpPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => p.userId === userId && !p.closedAt)
      .map((p) => ({ ...p }));
  }

  async getOpenPositionByUserAndTicker(
    userId: string,
    ticker: string
  ): Promise<PerpPositionRecord | null> {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.ticker === ticker && !p.closedAt
    );
    return pos ? { ...pos } : null;
  }

  async lockOpenPositionById(id: string): Promise<PerpPositionRecord | null> {
    const pos = this.positions.get(id);
    if (!pos || pos.closedAt) return null;
    return { ...pos };
  }

  async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async upsertPosition(
    position: Omit<PerpPositionRecord, 'id'> & { id?: string }
  ): Promise<PerpPositionRecord> {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record: PerpPositionRecord = {
      id,
      userId: position.userId,
      ticker: position.ticker,
      organizationId: position.organizationId,
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      size: position.size,
      leverage: position.leverage,
      liquidationPrice: position.liquidationPrice,
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLPercent: position.unrealizedPnLPercent,
      fundingPaid: position.fundingPaid,
      openedAt: position.openedAt,
      lastUpdated: position.lastUpdated,
      closedAt: position.closedAt ?? null,
      realizedPnL: position.realizedPnL ?? null,
    };
    this.positions.set(id, record);
    return { ...record };
  }

  async updateOpenPosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
        | 'fundingPaid'
        | 'liquidationPrice'
        | 'lastUpdated'
        | 'size'
        | 'entryPrice'
      >
    >
  ): Promise<void> {
    const pos = this.positions.get(positionId);
    if (!pos || pos.closedAt) return;
    this.positions.set(positionId, {
      ...pos,
      ...updates,
      lastUpdated: updates.lastUpdated ?? new Date(),
    });
  }

  async closePosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'closedAt'
        | 'realizedPnL'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
      >
    >
  ): Promise<boolean> {
    const pos = this.positions.get(positionId);
    if (!pos || pos.closedAt) return false;
    this.positions.set(positionId, {
      ...pos,
      closedAt: updates.closedAt ?? new Date(),
      currentPrice: updates.currentPrice ?? pos.currentPrice,
      realizedPnL: updates.realizedPnL ?? pos.realizedPnL,
      unrealizedPnL: updates.unrealizedPnL ?? 0,
      unrealizedPnLPercent: updates.unrealizedPnLPercent ?? 0,
    });
    return true;
  }

  async applyMarketDeltas(
    ticker: string,
    deltas: { openInterest?: number; volume24h?: number }
  ): Promise<{ openInterest: number; volume24h: number }> {
    const current = this.markets.get(ticker);
    if (!current) throw new Error(`Market not found: ${ticker}`);
    const openInterest = Math.max(
      0,
      current.openInterest + (deltas.openInterest ?? 0)
    );
    const volume24h = current.volume24h + (deltas.volume24h ?? 0);
    this.markets.set(ticker, { ...current, openInterest, volume24h });
    return { openInterest, volume24h };
  }

  async updateMarketStats(): Promise<void> {}
}

describe('perp open fee failure (post-commit bookkeeping)', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;

  const baseMarket: PerpMarketRecord = {
    ticker: 'ABC',
    organizationId: 'org-abc',
    name: 'ABC Corp',
    currentPrice: 100,
    change24h: 0,
    changePercent24h: 0,
    high24h: 100,
    low24h: 100,
    volume24h: 0,
    openInterest: 0,
    fundingRate: {
      ticker: 'ABC',
      rate: 0,
      nextFundingTime: new Date().toISOString(),
      predictedRate: 0,
    },
    maxLeverage: 100,
    minOrderSize: 10,
    markPrice: 100,
    indexPrice: 100,
  };

  beforeEach(() => {
    db = new InMemoryPerpDb([baseMarket]);
    wallet = new InMemoryWallet(10_000);
  });

  function buildService(
    feeProcessor: ThrowingFeeProcessor | FlakyFeeProcessor,
    outbox: RecordingOutbox | ThrowingOutbox
  ) {
    return new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      feeProcessor,
      tradingFeeOutbox: outbox,
    });
  }

  it('open LONG 200 at 2x still succeeds when the fee ledger always fails', async () => {
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    // Pre-fix this rejects with 'injected fee ledger failure' even though
    // the position and the cash debit have already committed.
    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 200,
      leverage: 2,
    });

    expect(result.positionId).toBeTruthy();
    expect(result.feePaid).toBeCloseTo(0.2, 10);

    // The committed trade is exactly what the reviewer reproduced:
    // 200-notional position, cash 10000 - (200/2 margin + 0.20 fee).
    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.size).toBe(200);
    expect(positions[0]?.id).toBe(result.positionId);
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(9899.8, 6);

    // Retries exhausted, then the fee intent is persisted for the cron
    // drain instead of being dropped silently — and it must already exist
    // when openPosition resolves (no waitFor): the A2A path has no
    // waitUntil/after, so a later row would only prove eventual recovery
    // while the process stays alive, not durability at resolve time.
    expect(outbox.calls).toHaveLength(1);
    expect(feeProcessor.calls).toHaveLength(3);
    expectOperationIds(feeProcessor, 1);
    expect(feeProcessor.calls[0]).toEqual({
      amount: 200,
      type: 'perp_open',
    });
    expect(outbox.calls[0]).toMatchObject({
      userId: 'u1',
      amount: 200,
      type: 'perp_open',
      relatedId: 'ABC',
      positionId: result.positionId,
    });
    // The queued intent carries the leg's key so the drain replays
    // under it instead of charging a second fee.
    expect(outbox.calls[0]?.operationId).toBe(feeProcessor.operationIds[0]);
  });

  it('a transient fee failure recovers inline without touching the outbox', async () => {
    const feeProcessor = new FlakyFeeProcessor(2);
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 200,
      leverage: 2,
    });
    expect(result.positionId).toBeTruthy();

    // Awaited inline: all three attempts complete before openPosition
    // resolves, so no waitFor is needed.
    expect(feeProcessor.calls).toBe(3);
    expect(outbox.calls).toHaveLength(0);
  });

  it('an outbox failure still does not fail the committed trade', async () => {
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new ThrowingOutbox();
    const service = buildService(feeProcessor, outbox);

    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 200,
      leverage: 2,
    });
    expect(result.positionId).toBeTruthy();

    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(1);
    // The fee intent could not be persisted; the critical log inside
    // processFeeWithRetry is the only record — the trade still stands.
    // Awaited inline: all three attempts complete before openPosition
    // resolves, so no waitFor is needed.
    expect(feeProcessor.calls).toHaveLength(3);
  });
});

describe('perp close/add/reduce/flip fee failure (post-commit bookkeeping)', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;

  const baseMarket: PerpMarketRecord = {
    ticker: 'ABC',
    organizationId: 'org-abc',
    name: 'ABC Corp',
    currentPrice: 100,
    change24h: 0,
    changePercent24h: 0,
    high24h: 100,
    low24h: 100,
    volume24h: 0,
    openInterest: 0,
    fundingRate: {
      ticker: 'ABC',
      rate: 0,
      nextFundingTime: new Date().toISOString(),
      predictedRate: 0,
    },
    maxLeverage: 100,
    minOrderSize: 10,
    markPrice: 100,
    indexPrice: 100,
  };

  beforeEach(() => {
    db = new InMemoryPerpDb([baseMarket]);
    wallet = new InMemoryWallet(10_000);
  });

  function buildService(
    feeProcessor: ThrowingFeeProcessor | FlakyFeeProcessor,
    outbox: RecordingOutbox | ThrowingOutbox
  ) {
    return new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      feeProcessor,
      tradingFeeOutbox: outbox,
    });
  }

  /** Open LONG 200 at 2x with a fee processor that settles inline. */
  async function openLong200(): Promise<string> {
    const service = buildService(
      new FlakyFeeProcessor(0),
      new RecordingOutbox()
    );
    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 200,
      leverage: 2,
    });
    expect(result.positionId).toBeTruthy();
    return result.positionId;
  }

  it('explicit close still succeeds and the close fee intent is durable at return time', async () => {
    const positionId = await openLong200();
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    // Pre-fix this resolved with zero outbox rows: the fee call was
    // fire-and-forget, so the intent only appeared after later retries
    // while the process stayed alive.
    const result = await service.closePosition({
      userId: 'u1',
      positionId,
      percentage: 1,
    });

    expect(result.fullyClosed).toBe(true);
    expect(result.feePaid).toBeCloseTo(0.2, 10);
    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(0);
    // The close fills at the synthetic execution price (below spot for a
    // long sell), so realised PnL is negative; assert the balance from the
    // reported settlement fields, mirroring PerpMarketService.test.ts:
    // 9899.80 + (margin 100 + realised PnL - fee 0.20).
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(
      9899.8 +
        (result.marginPaid ?? 0) +
        (result.realizedPnL ?? 0) -
        result.feePaid,
      6
    );

    expect(outbox.calls).toHaveLength(1);
    expect(feeProcessor.calls).toHaveLength(3);
    expectOperationIds(feeProcessor, 1);
    expect(feeProcessor.calls[0]).toEqual({
      amount: 200,
      type: 'perp_close',
    });
    expect(outbox.calls[0]).toMatchObject({
      userId: 'u1',
      amount: 200,
      type: 'perp_close',
      relatedId: 'ABC',
      positionId,
    });
  });

  it('add-to-position still succeeds and the add fee intent is durable at return time', async () => {
    const positionId = await openLong200();
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 2,
    });

    expect(result.positionId).toBe(positionId);
    expect(result.size).toBe(300);
    expect(result.feePaid).toBeCloseTo(0.1, 10);
    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.size).toBe(300);
    // Added margin 50 + fee 0.10 debited: 9899.80 - 50.10.
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(9849.7, 6);

    expect(outbox.calls).toHaveLength(1);
    expect(feeProcessor.calls).toHaveLength(3);
    expectOperationIds(feeProcessor, 1);
    expect(feeProcessor.calls[0]).toEqual({
      amount: 100,
      type: 'perp_add_to_position',
    });
    expect(outbox.calls[0]).toMatchObject({
      userId: 'u1',
      amount: 100,
      type: 'perp_add_to_position',
      relatedId: 'ABC',
      positionId,
    });
  });

  it('reduce still succeeds and the close fee intent is durable at return time', async () => {
    const positionId = await openLong200();
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    // Opposite-side short 100 against long 200 is a partial close.
    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 100,
      leverage: 2,
    });

    expect(result.rebalanceType).toBe('reduce');
    expect(result.remainingSize).toBe(100);
    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.size).toBe(100);
    // Half the margin back plus the partial close's realised PnL (negative:
    // synthetic exit fill below spot) less the fee, from the reported
    // settlement fields: 9899.80 + (50 + realised PnL - 0.10).
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(
      9899.8 +
        (result.marginPaid ?? 0) +
        (result.realizedPnL ?? 0) -
        result.feePaid,
      6
    );

    expect(outbox.calls).toHaveLength(1);
    expect(feeProcessor.calls).toHaveLength(3);
    expectOperationIds(feeProcessor, 1);
    expect(feeProcessor.calls[0]).toEqual({
      amount: 100,
      type: 'perp_close',
    });
    expect(outbox.calls[0]).toMatchObject({
      userId: 'u1',
      amount: 100,
      type: 'perp_close',
      relatedId: 'ABC',
      positionId,
    });
  });

  it('flip still succeeds and both legs fee intents are durable at return time', async () => {
    const positionId = await openLong200();
    const feeProcessor = new ThrowingFeeProcessor();
    const outbox = new RecordingOutbox();
    const service = buildService(feeProcessor, outbox);

    // Opposite-side short 300 against long 200 flips to short 100.
    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 300,
      leverage: 2,
    });

    expect(result.rebalanceType).toBe('flip');
    expect(result.side).toBe('short');
    expect(result.size).toBe(100);
    const positions = await db.getOpenPositionsByUser('u1');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.side).toBe('short');
    expect(positions[0]?.size).toBe(100);
    // One net wallet movement: close settlement (margin 100 + realised PnL
    // - close fee) minus the flip leg's cost (new margin + open fee). Both
    // fees are in result.feePaid and the new margin in result.marginPaid:
    // 9899.80 + 100 + realised PnL - total fees - new margin.
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(
      9899.8 +
        100 +
        (result.realizedPnL ?? 0) -
        result.feePaid -
        (result.marginPaid ?? 0),
      6
    );

    // Both legs run concurrently, so assert the set, not the order.
    expect(outbox.calls).toHaveLength(2);
    expect(feeProcessor.calls).toHaveLength(6);
    // Two legs, two operation ids, one per leg: all three retries of the
    // close leg share one id, all three of the flip leg share the other.
    expectOperationIds(feeProcessor, 2);
    const idsByType = new Map<string, Set<string>>();
    feeProcessor.calls.forEach((call, index) => {
      const id = feeProcessor.operationIds[index];
      expect(id).toBeTruthy();
      const set = idsByType.get(call.type) ?? new Set<string>();
      set.add(id as string);
      idsByType.set(call.type, set);
    });
    expect(idsByType.get('perp_close')?.size).toBe(1);
    expect(idsByType.get('perp_flip_position')?.size).toBe(1);
    const feeTypes = feeProcessor.calls.map((c) => c.type).sort();
    expect(feeTypes).toEqual([
      'perp_close',
      'perp_close',
      'perp_close',
      'perp_flip_position',
      'perp_flip_position',
      'perp_flip_position',
    ]);
    const outboxByType = new Map(outbox.calls.map((c) => [c.type, c]));
    expect(outboxByType.get('perp_close')).toMatchObject({
      userId: 'u1',
      amount: 200,
      relatedId: 'ABC',
      positionId,
    });
    expect(outboxByType.get('perp_flip_position')).toMatchObject({
      userId: 'u1',
      amount: 100,
      relatedId: 'ABC',
      positionId: result.positionId,
    });
  });
});
