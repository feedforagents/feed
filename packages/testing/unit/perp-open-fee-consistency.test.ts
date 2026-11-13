/**
 * Perp open fee consistency: the fee a trader is charged must be the fee
 * the fee ledger records and splits.
 *
 * Production wiring (apps/web/src/app/api/markets/perps/_adapters.ts):
 * the open route builds PerpMarketService with `perpFeeConfig` (the
 * FEE_CONFIG values) and `createFeeProcessorAdapter()`, which forwards
 * every open to FeeService.processTradingFee. PerpMarketService debits
 * margin + its own calculateFee() result and reports it as feePaid (the
 * preview shows the same number as estimatedFee), while FeeService
 * records and splits its own calculateFee() result into tradingFees,
 * users.totalFeesPaid, the platform/referrer shares and the stability
 * fund. FeeService works in integer cents from the one canonical fee
 * (PRD §9.1: the fee on the cent-settled amount, rounded UP to whole
 * cents, so platform + referrer always equals the total); the perp
 * service must charge that same canonical fee, or the books disagree
 * with the debit.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type PerpDbPort,
  type PerpMarketRecord,
  PerpMarketService,
  type PerpPositionRecord,
  type WalletPort,
} from '@feed/core/markets/perps';
import { FEE_CONFIG, FeeService } from '@feed/engine';

// Mirrors `perpFeeConfig` in apps/web/src/app/api/markets/perps/_adapters.ts.
const feeConfig = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

/**
 * Mirrors `createFeeProcessorAdapter`: the fee that gets recorded,
 * totalled into users.totalFeesPaid and split between platform and
 * referrer is FeeService.calculateFee(amount) — see
 * FeeService.processTradingFee, whose record/split/total all derive from
 * that single calculation.
 */
class RecordingFeeProcessor {
  calls: Array<{ amount: number; type: string; feeCharged: number }> = [];

  async processTradingFee(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
  }): Promise<{ feeCharged: number; referrerPaid?: number }> {
    const calc = FeeService.calculateFee(params.amount);
    this.calls.push({
      amount: params.amount,
      type: params.type,
      feeCharged: calc.feeAmount,
    });
    return { feeCharged: calc.feeAmount, referrerPaid: calc.referrerShare };
  }
}

class InMemoryWallet implements WalletPort {
  private balances = new Map<string, number>();
  private pnls: Array<{ userId: string; pnl: number; reason: string }> = [];

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

  async recordPnL({
    userId,
    pnl,
    reason,
  }: {
    userId: string;
    pnl: number;
    reason: string;
  }): Promise<void> {
    this.pnls.push({ userId, pnl, reason });
  }

  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }

  getPnLs(userId: string) {
    return this.pnls.filter((p) => p.userId === userId);
  }
}

class InMemoryPerpDb implements PerpDbPort {
  private markets = new Map<string, PerpMarketRecord>();
  private positions = new Map<string, PerpPositionRecord>();
  private idCounter = 1;

  constructor(initialMarkets: PerpMarketRecord[]) {
    initialMarkets.forEach((m) => this.markets.set(m.ticker, { ...m }));
  }

  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]> {
    const all = Array.from(this.markets.values())
      .sort((a, b) => a.ticker.localeCompare(b.ticker))
      .map((m) => ({ ...m }));
    if (options?.limit == null) return all;
    const off = options.offset ?? 0;
    return all.slice(off, off + options.limit);
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

  async updateMarketStats(
    ticker: string,
    updates: Partial<
      Pick<
        PerpMarketRecord,
        | 'currentPrice'
        | 'change24h'
        | 'changePercent24h'
        | 'high24h'
        | 'low24h'
        | 'volume24h'
        | 'openInterest'
        | 'fundingRate'
        | 'bidPrice'
        | 'askPrice'
        | 'spreadBps'
        | 'bidDepth'
        | 'askDepth'
        | 'liquidityRegime'
        | 'quoteUpdatedAt'
        | 'markPrice'
        | 'indexPrice'
        | 'maxLeverage'
        | 'minOrderSize'
      >
    >
  ): Promise<void> {
    const current = this.markets.get(ticker);
    if (!current) throw new Error(`Market not found: ${ticker}`);
    this.markets.set(ticker, {
      ...current,
      ...updates,
    });
  }
}

describe('perp open fee consistency (charged vs recorded)', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;
  let feeProcessor: RecordingFeeProcessor;
  let service: PerpMarketService;

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
    feeProcessor = new RecordingFeeProcessor();
    service = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      feeProcessor,
    });
  });

  async function openAndCheck(size: number, leverage: number) {
    const preview = await service.previewOpenPosition({
      ticker: 'ABC',
      side: 'long',
      size,
      leverage,
    });
    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size,
      leverage,
    });
    if (result.marginPaid === undefined) {
      throw new Error('openPosition did not return marginPaid');
    }

    expect(feeProcessor.calls).toHaveLength(1);
    const recorded = feeProcessor.calls[0]!;
    expect(recorded.type).toBe('perp_open');
    expect(recorded.amount).toBe(size);

    // The fee in the ledger (recorded, split, totalled) must be the fee
    // the trader was actually charged and shown.
    expect(recorded.feeCharged).toBeCloseTo(result.feePaid, 10);
    expect(preview.estimatedFee).toBeCloseTo(result.feePaid, 10);
    expect(preview.totalRequired).toBeCloseTo(
      result.marginPaid + result.feePaid,
      10
    );

    // The wallet debit is exactly margin + the same fee.
    const balance = await wallet.getBalance('u1');
    expect(balance.balance).toBeCloseTo(
      10_000 - (result.marginPaid + result.feePaid),
      6
    );
    return result;
  }

  it('charges the recorded fee on a $15 open at 5x leverage', async () => {
    const result = await openAndCheck(15, 5);
    // Canonical fee: ceil(15 * 0.1%) = ceil(1.5 cents) = 2 cents.
    expect(result.feePaid).toBeCloseTo(0.02, 10);
  });

  it('charges the recorded fee on a $25 open at 2x leverage', async () => {
    const result = await openAndCheck(25, 2);
    expect(result.feePaid).toBeCloseTo(0.03, 10);
  });

  it('charges the recorded fee on a $14 open (fee rounds up)', async () => {
    const result = await openAndCheck(14, 1);
    // Canonical fee: ceil(14 * 0.1%) = ceil(1.4 cents) = 2 cents. The
    // ceiling is the partition-safe rule (PRD §9.1): a round-to-nearest
    // fee let split trades pay less total fee than the whole trade.
    expect(result.feePaid).toBeCloseTo(0.02, 10);
  });

  it('still agrees on a round $100 open (control)', async () => {
    const result = await openAndCheck(100, 10);
    expect(result.feePaid).toBeCloseTo(0.1, 10);
  });
});
