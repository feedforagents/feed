import { describe, expect, it } from 'bun:test';
import type { WalletPort } from '../../shared/common';
import { PerpMarketService } from '../PerpMarketService';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
} from '../types';

/** A gap close may settle at zero, so stored and returned PnL must cap the
 * loss at the margin actually available on each closed leg. */

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
  pnls: Array<{ pnl: number; reason: string }> = [];
  async recordPnL({ pnl, reason }: { pnl: number; reason: string }) {
    this.pnls.push({ pnl, reason });
  }
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
  async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async upsertPosition(
    position: Omit<PerpPositionRecord, 'id'> & { id?: string }
  ) {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record = {
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
  async closePosition(
    positionId: string,
    updates: Partial<PerpPositionRecord>
  ) {
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
  maxLeverage: 100,
  minOrderSize: 10,
  markPrice: 100,
  indexPrice: 100,
};

describe('close beyond margin: stored vs recorded PnL', () => {
  it('reports the divergence', async () => {
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
    });
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });
    // Gap down 50%: raw PnL -50 on margin 10, no liquidation step ran.
    await db.updateMarketStats('ABC', { currentPrice: 50 });
    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });
    const stored = await db.getPositionById(open.positionId);
    const recorded = wallet.pnls.filter((p) => p.reason === 'perp_close');
    // Margin for the leg is 100/10 = 10: stored, returned and recorded PnL
    // must all agree at the -margin cap instead of -50 vs -10.
    expect(close.realizedPnL).toBeCloseTo(-10, 4);
    expect(stored?.realizedPnL).toBeCloseTo(-10, 4);
    expect(recorded.map((p) => p.pnl)).toEqual([-10]);
    const balance = await wallet.getBalance('u1');
    // Open cost 10.1; close settles 0, so balance is 10000 - 10.1.
    expect(balance.balance).toBeCloseTo(9989.9, 4);
  });
});
