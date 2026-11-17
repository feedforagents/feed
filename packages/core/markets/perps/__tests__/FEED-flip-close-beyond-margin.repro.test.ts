import { describe, expect, it } from 'bun:test';
import type { WalletPort } from '../../shared/common';
import { PerpMarketService } from '../PerpMarketService';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
} from '../types';

/**
 * REPRO (candidate): the flip path inlines the close-leg settlement
 * (reduceOrFlipPosition, STEP 1) instead of routing through closePosition,
 * so it never applies the leg-margin cap that closePosition applies to the
 * stored/returned realized PnL. When the close leg loses more than its
 * margin, the closed position row stores the uncapped loss while the
 * wallet books only the capped loss (netSettlement is floored at 0), so
 * the two records of the same close disagree past the margin.
 *
 * Scenario: long 100 @ 100, 10x (margin 10). Price crashes to 40, then
 * the user flips to short 300. Close-leg PnL is about -60, but the
 * settlement can only return 0, so the economic loss is capped at -10.
 *
 * Expected after fix: the flip's stored and returned close-leg realized
 * PnL are capped at -marginPaid (-10), matching the wallet record.
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

describe('FEED flip close leg beyond margin (repro)', () => {
  it('caps the flip close-leg realized PnL at the leg margin', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet();
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
    // Margin paid on the close leg: 100 / 10 = 10.
    const closeMarginPaid = 100 / 10;

    // Crash the price far below the liquidation price (90). The flip
    // reads the market directly, so no liquidation sweep runs first.
    await db.updateMarketStats('ABC', {
      currentPrice: 40,
      markPrice: 40,
      indexPrice: 40,
    });

    const flip = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 300,
      leverage: 10,
    });
    expect(flip.rebalanceType).toBe('flip');

    // The close leg lost ~60, but the settlement returned 0, so the
    // economic loss on the close leg is capped at the margin (10).
    const closed = await db.getPositionById(open.positionId);
    expect(closed?.closedAt).toBeDefined();
    // Stored close-leg realized PnL must not exceed the margin loss.
    expect(closed?.realizedPnL).toBeCloseTo(-closeMarginPaid, 4);
    // Returned close-leg realized PnL must agree with the stored value.
    expect(flip.realizedPnL).toBeCloseTo(-closeMarginPaid, 4);

    // The wallet books the capped loss (close leg -10, minus the 0.2
    // open fee on the 200 inverse leg), so the stored value must agree
    // with it up to that open fee.
    const flipPnl = wallet.pnls.find((p) => p.reason === 'perp_flip_position');
    expect(flipPnl?.pnl).toBeCloseTo(-closeMarginPaid - 0.2, 4);
  });
});
