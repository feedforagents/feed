/**
 * Perp open fee failure: a fee-ledger failure after the trade commits must
 * not turn the committed trade into a reported failure.
 *
 * Regression test for feed #1586 (SYMBaiEX change request): on the old code
 * `openPosition` awaited `FeeService.processTradingFee` directly after the
 * settlement transaction had committed, so a fee-ledger error surfaced as
 * an exception while the 200-notional position and the cash debit were
 * already committed — and an agent retry would open a second position.
 * The open path now uses the same fire-and-forget `processFeeWithRetry`
 * (+ outbox) as close / add-to-position / flip, so the successful trade
 * result is preserved and the fee intent survives for the outbox drain.
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

  async processTradingFee(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
  }): Promise<{ feeCharged: number; referrerPaid?: number }> {
    this.calls.push({ amount: params.amount, type: params.type });
    throw new Error('injected fee ledger failure');
  }
}

/** Fails `failTimes` attempts, then settles like the real FeeService. */
class FlakyFeeProcessor {
  calls = 0;
  constructor(private failTimes: number) {}

  async processTradingFee(_params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
  }): Promise<{ feeCharged: number; referrerPaid?: number }> {
    this.calls += 1;
    if (this.calls <= this.failTimes) {
      throw new Error('injected fee ledger failure');
    }
    return { feeCharged: 0.2, referrerPaid: 0 };
  }
}

class RecordingOutbox {
  calls: Array<{
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
  }> = [];

  async enqueue(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
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

  async updateOpenPosition(): Promise<void> {}

  async closePosition(): Promise<boolean> {
    return false;
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await Bun.sleep(25);
  }
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
    // drain instead of being dropped silently.
    await waitFor(() => outbox.calls.length === 1);
    expect(feeProcessor.calls).toHaveLength(3);
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

    await waitFor(() => feeProcessor.calls === 3);
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
    await waitFor(() => feeProcessor.calls.length === 3);
  });
});
