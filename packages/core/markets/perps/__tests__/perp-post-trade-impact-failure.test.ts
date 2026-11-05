import { describe, expect, it } from 'bun:test';
import type { WalletPort } from '../../shared/common';
import { PerpMarketService } from '../PerpMarketService';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
  PriceImpactPort,
} from '../types';

/**
 * Repro: a perp open commits (debit + position + market deltas) and then
 * applyPostTradeImpact throws because the price-impact port cannot supply
 * pricing context. The real port returns undefined from getBasePrice when
 * the organizationState row is missing, and returns undefined from
 * applyAndGetPrice on any internal error (it swallows the error and logs).
 * The service turns that undefined into a thrown error AFTER settlement, so
 * openPosition rejects even though the trade committed. A caller that
 * reports failure invites a retry, and a retry open routes to
 * addToPosition — doubling exposure instead of being idempotent.
 */

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

class ReproWallet implements WalletPort {
  private balances = new Map<string, number>();
  constructor(private defaultBalance = 10_000) {}
  async debit({ userId, amount }: { userId: string; amount: number }) {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    if (balance < amount) throw new Error('Insufficient funds');
    this.balances.set(userId, balance - amount);
  }
  async credit({ userId, amount }: { userId: string; amount: number }) {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, balance + amount);
  }
  async recordPnL() {}
  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class ReproDb implements PerpDbPort {
  private markets = new Map<string, PerpMarketRecord>();
  private positions = new Map<string, PerpPositionRecord>();
  private idCounter = 1;
  constructor(initialMarkets: PerpMarketRecord[]) {
    initialMarkets.forEach((m) => this.markets.set(m.ticker, { ...m }));
  }
  async listMarkets() {
    return Array.from(this.markets.values()).map((m) => ({ ...m }));
  }
  async countMarkets() {
    return this.markets.size;
  }
  async listOpenPositions() {
    return Array.from(this.positions.values())
      .filter((p) => !p.closedAt)
      .map((p) => ({ ...p }));
  }
  async getPositionById(id: string) {
    const pos = this.positions.get(id);
    return pos ? { ...pos } : null;
  }
  async getOpenPositionsByUser(userId: string) {
    return Array.from(this.positions.values())
      .filter((p) => p.userId === userId && !p.closedAt)
      .map((p) => ({ ...p }));
  }
  async getOpenPositionByUserAndTicker(userId: string, ticker: string) {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.ticker === ticker && !p.closedAt
    );
    return pos ? { ...pos } : null;
  }
  async lockOpenPositionById(id: string) {
    const pos = this.positions.get(id);
    return pos && !pos.closedAt ? { ...pos } : null;
  }
  async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>) {
    return fn(this);
  }
  async upsertPosition(
    position: Omit<PerpPositionRecord, 'id'> & { id?: string }
  ) {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record: PerpPositionRecord = {
      ...position,
      id,
      closedAt: position.closedAt ?? null,
      realizedPnL: position.realizedPnL ?? null,
    } as PerpPositionRecord;
    this.positions.set(id, record);
    return { ...record };
  }
  async updateOpenPosition(
    positionId: string,
    updates: Partial<PerpPositionRecord>
  ) {
    const pos = this.positions.get(positionId);
    if (!pos || pos.closedAt) return;
    this.positions.set(positionId, {
      ...pos,
      ...updates,
      lastUpdated: new Date(),
    });
  }
  async closePosition(positionId: string, updates: Partial<PerpPositionRecord>) {
    const pos = this.positions.get(positionId);
    if (!pos || pos.closedAt) return false;
    this.positions.set(positionId, {
      ...pos,
      closedAt: updates.closedAt ?? new Date(),
      currentPrice: updates.currentPrice ?? pos.currentPrice,
      realizedPnL: updates.realizedPnL ?? pos.realizedPnL,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
    });
    return true;
  }
  async applyMarketDeltas(
    ticker: string,
    deltas: { openInterest?: number; volume24h?: number }
  ) {
    const current = this.markets.get(ticker)!;
    const openInterest = Math.max(
      0,
      current.openInterest + (deltas.openInterest ?? 0)
    );
    const volume24h = current.volume24h + (deltas.volume24h ?? 0);
    this.markets.set(ticker, { ...current, openInterest, volume24h });
    return { openInterest, volume24h };
  }
  async updateMarketStats(ticker: string, updates: Partial<PerpMarketRecord>) {
    const current = this.markets.get(ticker)!;
    this.markets.set(ticker, { ...current, ...updates });
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
  maxLeverage: 20,
  minOrderSize: 10,
  markPrice: 100,
  indexPrice: 100,
};

// Mirrors the real port's failure mode: pricing context unavailable.
const failingImpactPort: PriceImpactPort = {
  getBasePrice: async () => undefined,
  applyAndGetPrice: async () => undefined,
};

describe('FEED repro: post-trade price impact failure', () => {
  it('does not turn a committed open into a reported failure', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const service = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      priceImpact: failingImpactPort,
    });

    const result = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    expect(result.positionId).toBeDefined();
    // Margin 10 + fee 0.1 debited exactly once.
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(9989.9, 4);
    const positions = await db.listOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.id).toBe(result.positionId);
  });

  it('does not turn a settled close into a reported failure', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const noImpact = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
    });
    const open = await noImpact.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });
    // Close with a price-impact port that cannot supply pricing context.
    // Note: closePosition only calls the impact port when a close impact
    // was previewed, which requires the port to be configured at close
    // time; the service under test here has it, and the port's
    // getBasePrice returning undefined makes previewImpactFill throw only
    // if reached — instead, exercise the post-close step directly via a
    // port whose applyAndGetPrice returns undefined.
    const closeService = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      priceImpact: {
        getBasePrice: async () => 100,
        applyAndGetPrice: async () => undefined,
      },
    });
    const closed = await closeService.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });
    expect(closed.fullyClosed).toBe(true);
    expect(await db.listOpenPositions()).toHaveLength(0);
  });
});
