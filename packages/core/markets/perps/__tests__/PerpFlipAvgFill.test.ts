import { describe, expect, it } from 'bun:test';
import {
  calculateRawPriceFromHoldings,
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

function build(withImpact: boolean) {
  const db = new InMemoryPerpDb([{ ...baseMarket }]);
  const wallet = new InMemoryWallet(10_000);
  const basePrice = 100;
  const priceImpact: PriceImpactPort = {
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
  const service = new PerpMarketService({
    settlement: {
      run: async (_userId, operation) =>
        db.transaction((tx) => operation(tx, wallet)),
    },
    db,
    wallet,
    fees: feeConfig,
    ...(withImpact ? { priceImpact } : {}),
  });
  return { db, wallet, service };
}

describe('perp flip close leg vs standalone close (avg-fill parity)', () => {
  it('flip of a long settles the close leg like a standalone close + open', async () => {
    // Path A: single flip long 1000 -> short 1500
    const a = build(true);
    const aOpen = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const aBefore = (await a.wallet.getBalance('u1')).balance;
    const flip = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1500,
      leverage: 2,
    });
    const aAfter = (await a.wallet.getBalance('u1')).balance;
    const aClosed = await a.db.getPositionById(aOpen.positionId);
    const aNew = await a.db.getOpenPositionByUserAndTicker('u1', 'ABC');
    const aPnlTotal = a.wallet
      .getPnLs('u1')
      .slice(1) // skip the initial open's -fee record
      .reduce((s, p) => s + p.pnl, 0);

    // Path B: standalone close, then standalone open of the inverse size
    const b = build(true);
    const bOpen = await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const bBefore = (await b.wallet.getBalance('u1')).balance;
    const close = await b.service.closePosition({
      userId: 'u1',
      positionId: bOpen.positionId,
    });
    const open = await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 500,
      leverage: 2,
    });
    const bAfter = (await b.wallet.getBalance('u1')).balance;
    const bClosed = await b.db.getPositionById(bOpen.positionId);
    const bNew = await b.db.getOpenPositionByUserAndTicker('u1', 'ABC');
    const bPnlTotal = b.wallet
      .getPnLs('u1')
      .slice(1)
      .reduce((s, p) => s + p.pnl, 0);

    expect(aBefore).toBeCloseTo(bBefore, 6);

    // The two paths must settle identically.
    expect(flip.realizedPnL).toBeCloseTo(close.realizedPnL!, 6);
    expect(aClosed?.realizedPnL).toBeCloseTo(bClosed?.realizedPnL!, 6);
    expect(aAfter - aBefore).toBeCloseTo(bAfter - bBefore, 6);
    expect(aPnlTotal).toBeCloseTo(bPnlTotal, 6);
    expect(aNew?.entryPrice).toBeCloseTo(bNew?.entryPrice!, 6);
    expect(aNew?.liquidationPrice).toBeCloseTo(bNew?.liquidationPrice!, 6);
    expect(open.entryPrice).toBeCloseTo(aNew?.entryPrice!, 6);
  });

  it('flip of a short settles the close leg like a standalone close + open', async () => {
    const a = build(true);
    const aOpen = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });
    const flip = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1500,
      leverage: 2,
    });
    const aAfter = (await a.wallet.getBalance('u1')).balance;
    const aClosed = await a.db.getPositionById(aOpen.positionId);

    const b = build(true);
    const bOpen = await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });
    const close = await b.service.closePosition({
      userId: 'u1',
      positionId: bOpen.positionId,
    });
    await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 500,
      leverage: 2,
    });
    const bAfter = (await b.wallet.getBalance('u1')).balance;
    const bClosed = await b.db.getPositionById(bOpen.positionId);

    expect(flip.realizedPnL).toBeCloseTo(close.realizedPnL!, 6);
    expect(aClosed?.realizedPnL).toBeCloseTo(bClosed?.realizedPnL!, 6);
    expect(aAfter).toBeCloseTo(bAfter, 6);
  });

  it('without a price impact port, flip still equals close + open', async () => {
    const a = build(false);
    const aOpen = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const flip = await a.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1500,
      leverage: 2,
    });
    const aAfter = (await a.wallet.getBalance('u1')).balance;
    const aClosed = await a.db.getPositionById(aOpen.positionId);

    const b = build(false);
    const bOpen = await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const close = await b.service.closePosition({
      userId: 'u1',
      positionId: bOpen.positionId,
    });
    await b.service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 500,
      leverage: 2,
    });
    const bAfter = (await b.wallet.getBalance('u1')).balance;
    const bClosed = await b.db.getPositionById(bOpen.positionId);

    expect(flip.realizedPnL).toBeCloseTo(close.realizedPnL!, 6);
    expect(aClosed?.realizedPnL).toBeCloseTo(bClosed?.realizedPnL!, 6);
    expect(aAfter).toBeCloseTo(bAfter, 6);
  });
});

describe('flip/reduce/close preview matches execution (avg-fill parity)', () => {
  it('flip preview totalRequired and close settlement match execution (long)', async () => {
    const { db, wallet, service } = build(true);
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const before = (await wallet.getBalance('u1')).balance;
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1500,
      leverage: 2,
    });
    const flip = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1500,
      leverage: 2,
    });
    const after = (await wallet.getBalance('u1')).balance;
    const closed = await db.getPositionById(opened.positionId);

    expect(preview.previewType).toBe('flip');
    // The preview must price the close leg at the AMM average exit fill,
    // exactly like the flip settles it — otherwise the UI submit gate
    // (totalRequired) disagrees with the actual debit.
    expect(preview.estimatedClosePrice).toBeCloseTo(closed?.currentPrice!, 6);
    expect(preview.totalRequired).toBeCloseTo(Math.max(0, before - after), 6);
    expect(preview.estimatedCloseSettlement).toBeCloseTo(
      Math.max(0, 1000 / 2 + flip.realizedPnL! - 1),
      6
    );
  });

  it('flip preview matches execution (short)', async () => {
    const { db, wallet, service } = build(true);
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });
    const before = (await wallet.getBalance('u1')).balance;
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1500,
      leverage: 2,
    });
    const flip = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1500,
      leverage: 2,
    });
    const after = (await wallet.getBalance('u1')).balance;
    const closed = await db.getPositionById(opened.positionId);

    expect(preview.previewType).toBe('flip');
    expect(preview.estimatedClosePrice).toBeCloseTo(closed?.currentPrice!, 6);
    expect(preview.totalRequired).toBeCloseTo(Math.max(0, before - after), 6);
    expect(preview.estimatedCloseSettlement).toBeCloseTo(
      Math.max(0, 1000 / 2 + flip.realizedPnL! - 1),
      6
    );
  });

  it('reduce preview matches a partial close', async () => {
    const { service } = build(true);
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 500,
      leverage: 2,
    });
    const close = await service.closePosition({
      userId: 'u1',
      positionId: opened.positionId,
      percentage: 0.5,
    });

    expect(preview.previewType).toBe('reduce');
    expect(preview.estimatedClosePrice).toBeCloseTo(close.exitPrice!, 6);
    expect(preview.estimatedCloseSettlement).toBeCloseTo(
      Math.max(0, close.marginPaid! + close.realizedPnL! - close.feePaid!),
      6
    );
  });

  it('close preview matches a full close', async () => {
    const { service } = build(true);
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 2,
    });
    const close = await service.closePosition({
      userId: 'u1',
      positionId: opened.positionId,
    });

    expect(preview.previewType).toBe('close');
    expect(preview.estimatedClosePrice).toBeCloseTo(close.exitPrice!, 6);
    expect(preview.estimatedCloseSettlement).toBeCloseTo(
      Math.max(0, close.marginPaid! + close.realizedPnL! - close.feePaid!),
      6
    );
  });
});
