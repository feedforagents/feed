import { beforeEach, describe, expect, it } from 'bun:test';
import {
  calculateRawPriceFromHoldings,
  calculateTradeImpact,
  calculateUnrealizedPnL,
  PERP_MARKET_CONFIG,
} from '@feed/shared';
import type { WalletPort } from '../../shared/common';
import { PerpMarketService } from '../PerpMarketService';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
  PriceImpactPort,
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
    updates: Partial<PerpMarketRecord>
  ): Promise<void> {
    const current = this.markets.get(ticker);
    if (!current) throw new Error(`Market not found: ${ticker}`);
    this.markets.set(ticker, {
      ...current,
      ...updates,
    });
  }
}

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

/**
 * Price impact port that prices the market from the net open holdings,
 * mirroring the production adapter (constant-product reserves). Same shape
 * as the port in PerpMarketService.test.ts 'money-path regressions'.
 */
function createImpactPort(db: InMemoryPerpDb, basePrice: number) {
  const port: PriceImpactPort = {
    async getBasePrice() {
      return basePrice;
    },
    async applyAndGetPrice(ticker: string) {
      const net = (await db.listOpenPositions())
        .filter((p) => p.ticker === ticker)
        .reduce((sum, p) => sum + (p.side === 'long' ? p.size : -p.size), 0);
      const price = calculateRawPriceFromHoldings(
        basePrice,
        net,
        PERP_MARKET_CONFIG
      );
      await db.updateMarketStats(ticker, { currentPrice: price });
      return price;
    },
  };
  return port;
}

describe('add-to-position with price impact (BF-75)', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;
  let service: PerpMarketService;

  beforeEach(() => {
    db = new InMemoryPerpDb([baseMarket]);
    wallet = new InMemoryWallet(10_000);
    service = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      priceImpact: createImpactPort(db, 100),
    });
  });

  it('keeps stored unrealized PnL consistent with the stored entry/current after a long add', async () => {
    const first = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const added = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });

    // Guard: the weighted cost basis blend itself is unchanged.
    const incrementalFill = calculateTradeImpact(
      100,
      1000,
      1000,
      PERP_MARKET_CONFIG
    ).avgFillPrice;
    const expectedEntry =
      2000 / (1000 / first.entryPrice + 1000 / incrementalFill);
    expect(added.entryPrice).toBeCloseTo(expectedEntry, 6);

    const [pos] = await db.listOpenPositions();
    expect(pos).toBeDefined();
    expect(pos!.size).toBe(2000);
    expect(pos!.entryPrice).toBeCloseTo(expectedEntry, 6);

    // The record must be internally consistent: the stored unrealized PnL
    // is the PnL of the stored size at the stored current price against
    // the stored entry — the same recomputation applyPriceUpdates performs.
    const expected = calculateUnrealizedPnL(
      pos!.entryPrice,
      pos!.currentPrice,
      pos!.side,
      pos!.size
    );
    // The scenario must actually exercise impact (PnL is not ~0).
    expect(Math.abs(expected.pnl)).toBeGreaterThan(0.5);
    expect(pos!.unrealizedPnL).toBeCloseTo(expected.pnl, 6);
    expect(pos!.unrealizedPnLPercent).toBeCloseTo(expected.pnlPercent, 6);
  });

  it('keeps stored unrealized PnL consistent with the stored entry/current after a short add', async () => {
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });

    const [pos] = await db.listOpenPositions();
    expect(pos).toBeDefined();
    expect(pos!.size).toBe(2000);

    const expected = calculateUnrealizedPnL(
      pos!.entryPrice,
      pos!.currentPrice,
      pos!.side,
      pos!.size
    );
    expect(Math.abs(expected.pnl)).toBeGreaterThan(0.5);
    expect(pos!.unrealizedPnL).toBeCloseTo(expected.pnl, 6);
    expect(pos!.unrealizedPnLPercent).toBeCloseTo(expected.pnlPercent, 6);
  });
});
