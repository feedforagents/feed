// PRD \u00a79.3 item 8 [D-17b]: "Leverage cap reduced from 100x to 20x" and
// the decision table entry "D-17b | Max leverage? | 20x."
// The cap is global: a market record stored with the old 100x ceiling
// (schema default / bootstrap seed before this change) must not reopen it,
// a missing record value falls back to 20x, and a market configured below
// the cap keeps its tighter limit. Previews quote through the same cap so
// clients cannot price fills the open path would reject.
import { describe, expect, it } from 'bun:test';
import type { WalletPort } from '../../shared/common';
import { PerpMarketService } from '../PerpMarketService';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
} from '../types';

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

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
  private fundingClaims = new Set<string>();
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

  async claimFundingPeriod(
    positionId: string,
    periodStart: Date
  ): Promise<boolean> {
    const key = `${positionId}:${periodStart.getTime()}`;
    if (this.fundingClaims.has(key)) return false;
    this.fundingClaims.add(key);
    return true;
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
describe('Perp leverage cap (PRD 9.3 [D-17b]: max 20x)', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;
  let service: PerpMarketService;

  const makeMarket = (
    overrides: Partial<PerpMarketRecord> = {}
  ): PerpMarketRecord => ({
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
    ...overrides,
  });

  const setup = (markets: PerpMarketRecord[]) => {
    db = new InMemoryPerpDb(markets);
    wallet = new InMemoryWallet(10_000);
    service = new PerpMarketService({
      // #1604 made the settlement port required: fresh opens and flips run
      // through it, so the in-memory port must be wired even here.
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
    });
  };

  const seedPosition = (overrides: Partial<PerpPositionRecord> = {}) =>
    db.upsertPosition({
      userId: 'u1',
      ticker: 'ABC',
      organizationId: 'org-abc',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 1000,
      leverage: 100,
      liquidationPrice: 99,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: new Date(),
      lastUpdated: new Date(),
      ...overrides,
    });

  const open = (leverage: number) =>
    service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage,
    });

  it('rejects leverage above 20x on a market record stored with the old 100x ceiling', async () => {
    setup([makeMarket()]);
    await expect(open(21)).rejects.toThrow('Invalid leverage (1-20)');
    await expect(open(50)).rejects.toThrow('Invalid leverage (1-20)');
    await expect(open(100)).rejects.toThrow('Invalid leverage (1-20)');
  });

  it('allows exactly 20x on a market record stored with the old 100x ceiling', async () => {
    setup([makeMarket()]);
    const res = await open(20);
    expect(res.positionId).toBeTruthy();
    const pos = await db.getPositionById(res.positionId);
    expect(pos?.leverage).toBe(20);
  });

  it('falls back to 20x when the market record carries no maxLeverage', async () => {
    const m = makeMarket();
    delete (m as Partial<PerpMarketRecord>).maxLeverage;
    setup([m as PerpMarketRecord]);
    await expect(open(50)).rejects.toThrow('Invalid leverage (1-20)');
    const res = await open(20);
    expect(res.positionId).toBeTruthy();
  });

  it('keeps a market configured below the cap at its tighter limit', async () => {
    setup([makeMarket({ maxLeverage: 10 })]);
    await expect(open(15)).rejects.toThrow('Invalid leverage (1-10)');
    const res = await open(10);
    expect(res.positionId).toBeTruthy();
  });

  it('previewOpenPosition rejects leverage above the cap and allows exactly 20x', async () => {
    setup([makeMarket()]);
    await expect(
      service.previewOpenPosition({
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 500,
      })
    ).rejects.toThrow('Invalid leverage (1-20)');
    await expect(
      service.previewOpenPosition({
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 21,
      })
    ).rejects.toThrow('Invalid leverage (1-20)');
    const preview = await service.previewOpenPosition({
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 20,
    });
    expect(preview).toBeTruthy();
  });

  it('rejects a same-side add to a legacy 100x position even when the add requests 20x', async () => {
    setup([makeMarket()]);
    const seeded = await seedPosition();
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 1000,
        leverage: 20,
      })
    ).rejects.toThrow(
      'Cannot add to a position above the leverage cap (existing 100x exceeds 20x)'
    );
    const pos = await db.getPositionById(seeded.id);
    expect(pos?.size).toBe(1000);
    expect(pos?.leverage).toBe(100);
  });

  it('rejects a same-side add to a position above a tighter configured cap', async () => {
    setup([makeMarket({ maxLeverage: 10 })]);
    const seeded = await seedPosition({ leverage: 15 });
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      })
    ).rejects.toThrow(
      'Cannot add to a position above the leverage cap (existing 15x exceeds 10x)'
    );
    const pos = await db.getPositionById(seeded.id);
    expect(pos?.size).toBe(1000);
  });

  it('still allows a same-side add to an at-cap position', async () => {
    setup([makeMarket()]);
    const seeded = await seedPosition({ leverage: 20 });
    const res = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 20,
    });
    expect(res.positionId).toBe(seeded.id);
    const pos = await db.getPositionById(seeded.id);
    expect(pos?.size).toBe(1100);
    expect(pos?.leverage).toBe(20);
  });

  it('still allows reducing a legacy above-cap position', async () => {
    setup([makeMarket()]);
    const seeded = await seedPosition();
    const res = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 500,
      leverage: 20,
    });
    expect(res.positionId).toBe(seeded.id);
    const pos = await db.getPositionById(seeded.id);
    expect(pos?.size).toBe(500);
    expect(pos?.leverage).toBe(100);
  });

  it('previewOrder rejects leverage above the cap for a fresh open', async () => {
    setup([makeMarket()]);
    await expect(
      service.previewOrder({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 50,
      })
    ).rejects.toThrow('Invalid leverage (1-20)');
  });
});
