import { beforeEach, describe, expect, it } from 'bun:test';
import {
  calculateRawPriceFromHoldings,
  calculateTradeImpact,
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
    // In-memory mock just runs the function directly
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

describe('PerpMarketService', () => {
  let db: InMemoryPerpDb;
  let wallet: InMemoryWallet;
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
    service = new PerpMarketService({
      db,
      wallet,
      fees: feeConfig,
    });
  });

  it('opens a position and updates snapshot/OI/volume/balance', async () => {
    const res = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    expect(res.positionId).toBeDefined();
    const balance = await wallet.getBalance('u1');
    // margin 10 + fee 0.1 = 10.1 deducted from 10_000
    expect(balance.balance).toBeCloseTo(9989.9, 4);

    const markets = await db.listMarkets();
    const m = markets[0]!;
    // OI = notional size (not size * leverage)
    expect(m.openInterest).toBeCloseTo(100, 4);
    expect(m.volume24h).toBeCloseTo(100, 4);
  });

  it('closes a position with profit and updates OI/volume/balance', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Bump market price to 120 to realize profit
    await db.updateMarketStats('ABC', { currentPrice: 120 });

    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });

    const expectedPnl =
      ((close.exitPrice! - open.entryPrice) / open.entryPrice) * 100;
    expect(close.realizedPnL).toBeCloseTo(expectedPnl, 4);
    const markets = await db.listMarkets();
    const m = markets[0]!;
    expect(m.openInterest).toBeCloseTo(0, 4);
    expect(m.volume24h).toBeCloseTo(200, 4); // open + close size

    const balance = await wallet.getBalance('u1');
    const expectedBalance =
      10_000 -
      (open.marginPaid! + open.feePaid) +
      ((close.marginPaid ?? 0) + close.realizedPnL! - close.feePaid);
    expect(balance.balance).toBeCloseTo(expectedBalance, 4);

    // PnL should include fees:
    // - perp_open records -openFee
    // - perp_close records (netSettlement - marginPaid) which includes close fee
    const pnls = wallet.getPnLs('u1');
    const totalPnL = pnls.reduce((sum, p) => sum + p.pnl, 0);
    expect(totalPnL).toBeCloseTo(
      close.realizedPnL! - open.feePaid - close.feePaid,
      4
    );
  });

  it('closes a SHORT position with profit when price drops (direction + fees)', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 100,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', { currentPrice: 80 });

    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });

    const expectedPnl =
      ((open.entryPrice - close.exitPrice!) / open.entryPrice) * 100;
    expect(close.realizedPnL).toBeCloseTo(expectedPnl, 4);

    const balance = await wallet.getBalance('u1');
    const expectedBalance =
      10_000 -
      (open.marginPaid! + open.feePaid) +
      ((close.marginPaid ?? 0) + close.realizedPnL! - close.feePaid);
    expect(balance.balance).toBeCloseTo(expectedBalance, 4);

    const pnls = wallet.getPnLs('u1');
    const totalPnL = pnls.reduce((sum, p) => sum + p.pnl, 0);
    expect(totalPnL).toBeCloseTo(
      close.realizedPnL! - open.feePaid - close.feePaid,
      4
    );
  });

  it('calculates realized PnL from notional size while leverage only affects margin', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', { currentPrice: 110 });

    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });

    expect(open.marginPaid).toBeCloseTo(100, 4);
    expect(close.marginPaid).toBeCloseTo(100, 4);
    const expectedPnl =
      ((close.exitPrice! - open.entryPrice) / open.entryPrice) * 1000;
    expect(close.realizedPnL).toBeCloseTo(expectedPnl, 4);
  });

  it('liquidates a position on price drop and records loss', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Drop price below liquidation
    await service.applyPriceUpdates({ 'org-abc': 80 });

    const pos = await db.getPositionById(open.positionId);
    expect(pos?.closedAt).toBeDefined();

    const markets = await db.listMarkets();
    const m = markets[0]!;
    expect(m.openInterest).toBe(0);

    const pnls = wallet.getPnLs('u1');
    // Margin loss = size/leverage = 10
    expect(pnls.find((p) => p.reason === 'perp_liquidation')?.pnl).toBeCloseTo(
      -10,
      4
    );
  });

  it('updates unrealized PnL on price move without liquidation', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 5,
    });

    await service.applyPriceUpdates({ 'org-abc': 110 });
    const pos = await db.getPositionById(open.positionId);
    const expectedPnl = ((110 - open.entryPrice) / open.entryPrice) * 100;
    const expectedPnlPercent = (expectedPnl / 100) * 100;
    expect(pos?.unrealizedPnL).toBeCloseTo(expectedPnl, 4);
    expect(pos?.unrealizedPnLPercent).toBeCloseTo(expectedPnlPercent, 4);
    expect(pos?.closedAt).toBeNull();
  });

  it('processes funding and updates fundingPaid and fundingRate', async () => {
    // Open long 100 and short 50 to create imbalance
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });
    await service.openPosition({
      userId: 'u2',
      ticker: 'ABC',
      side: 'short',
      size: 50,
      leverage: 10,
    });

    await service.processFundingAndLiquidations();

    const longPos = (await db.listOpenPositions()).find(
      (p) => p.userId === 'u1'
    );
    const shortPos = (await db.listOpenPositions()).find(
      (p) => p.userId === 'u2'
    );

    expect(longPos?.fundingPaid ?? 0).toBeGreaterThan(0);
    expect(shortPos?.fundingPaid ?? 0).toBeLessThan(0);

    const market = (await db.listMarkets())[0]!;
    expect(market.fundingRate.rate).not.toBe(0);
  });

  it('partial close reduces position size and returns proportional margin', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Close 50% of position
    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      percentage: 0.5,
    });

    expect(close.fullyClosed).toBe(false);
    expect(close.remainingSize).toBeCloseTo(50, 4);

    // Position should still exist with reduced size
    const pos = await db.getPositionById(open.positionId);
    expect(pos?.closedAt).toBeNull();
    expect(pos?.size).toBeCloseTo(50, 4);

    // Volume should reflect the closed portion
    const markets = await db.listMarkets();
    const m = markets[0]!;
    expect(m.volume24h).toBeCloseTo(150, 4); // open 100 + close 50
    expect(m.openInterest).toBeCloseTo(50, 4); // remaining
  });

  it('rejects partial close below the market minimum order size', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    await expect(
      service.closePosition({
        userId: 'u1',
        positionId: open.positionId,
        percentage: 0.05,
      })
    ).rejects.toThrow(/minimum order size/);

    const pos = await db.getPositionById(open.positionId);
    expect(pos?.closedAt).toBeNull();
    expect(pos?.size).toBeCloseTo(100, 4);
  });

  it('slippage protection rejects open if price deviation exceeds max', async () => {
    // Set markPrice significantly different from spot
    await db.updateMarketStats('ABC', { currentPrice: 100, markPrice: 110 });

    // Try to open with tight slippage tolerance (5%)
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
        maxSlippage: 0.05, // 5% max
      })
    ).rejects.toThrow(/Slippage exceeded/);
  });

  it('slippage protection rejects close if price moved beyond tolerance', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Move price significantly
    await db.updateMarketStats('ABC', { currentPrice: 120 });

    // Try to close with tight slippage tolerance (10%)
    await expect(
      service.closePosition({
        userId: 'u1',
        positionId: open.positionId,
        maxSlippage: 0.1, // 10% max - price moved 20%
      })
    ).rejects.toThrow(/Slippage exceeded/);
  });

  it('allows close when slippage is within tolerance', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Move price slightly
    await db.updateMarketStats('ABC', { currentPrice: 105 });

    // Should succeed with 10% slippage tolerance
    const close = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      maxSlippage: 0.1, // 10% max - price moved only 5%
    });

    expect(close.fullyClosed).toBe(true);
    const expectedPnl =
      ((close.exitPrice! - open.entryPrice) / open.entryPrice) * 100;
    expect(close.realizedPnL).toBeCloseTo(expectedPnl, 4);
  });

  it('refreshes quote state toward tighter spreads over time', async () => {
    await db.updateMarketStats('ABC', {
      bidPrice: 90,
      askPrice: 110,
      spreadBps: 200,
      bidDepth: 100,
      askDepth: 100,
      liquidityRegime: 'thin',
      quoteUpdatedAt: new Date(Date.now() - 60_000),
    });

    const refreshed = await service.refreshQuoteStates();
    expect(refreshed).toBe(1);

    const market = (await db.listMarkets())[0]!;
    expect(market.spreadBps ?? 0).toBeLessThan(200);
    expect(market.bidDepth ?? 0).toBeGreaterThan(100);
    expect(market.askDepth ?? 0).toBeGreaterThan(100);
  });

  it('uses the same execution engine for open preview and open execution', async () => {
    const preview = await service.previewOpenPosition({
      ticker: 'ABC',
      side: 'long',
      size: 250,
      leverage: 10,
    });

    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 250,
      leverage: 10,
    });

    expect(preview.quotedPrice).toBeGreaterThan(0);
    expect(preview.executionPrice).toBeCloseTo(open.entryPrice, 8);
    expect(preview.marginRequired).toBeCloseTo(open.marginPaid ?? 0, 8);
    expect(preview.estimatedFee).toBeCloseTo(open.feePaid, 8);
    expect(preview.liquidationPrice).toBeCloseTo(open.liquidationPrice, 8);
  });

  it('previews flip rebalances with additional capital net of close settlement', async () => {
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 100,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', {
      currentPrice: 130,
      bidPrice: 129,
      askPrice: 131,
    });

    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 160,
      leverage: 5,
    });

    expect(preview.isRebalance).toBe(true);
    expect(preview.rebalanceType).toBe('flip');
    expect(preview.size).toBeCloseTo(60, 8);
    expect(preview.estimatedCloseSettlement).toBeDefined();
    expect(preview.totalRequired).toBeGreaterThanOrEqual(0);
  });

  describe('position rebalancing', () => {
    it('adds to position when opening same side (increases size, averages entry)', async () => {
      // Open initial LONG position at $100
      const initial = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Move price to $120
      await db.updateMarketStats('ABC', { currentPrice: 120 });

      // Add to position (same side) at new price
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Should rebalance existing position, not create new
      expect(result.positionId).toBe(initial.positionId);
      expect(result.isRebalance).toBe(true);
      expect(result.rebalanceType).toBe('add');
      expect(result.previousSize).toBe(100);
      expect(result.previousEntryPrice).toBeCloseTo(initial.entryPrice, 4);

      // New size should be 200
      expect(result.size).toBe(200);

      // Averaged entry should move upward after adding to a rising market.
      expect(result.entryPrice).toBeGreaterThan(initial.entryPrice);
      expect(result.entryPrice).toBeLessThan(130);

      // Verify position in DB
      const pos = await db.getPositionById(initial.positionId);
      expect(pos?.size).toBe(200);
      expect(pos?.entryPrice).toBeCloseTo(result.entryPrice, 4);
    });

    it('reduces position when opening opposite side with smaller size', async () => {
      // Open LONG position
      const initial = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Open opposite side (SHORT) with smaller size - should reduce
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'short',
        size: 30,
        leverage: 10,
      });

      expect(result.isRebalance).toBe(true);
      expect(result.rebalanceType).toBe('reduce');
      expect(result.previousSize).toBe(100);
      expect(result.remainingSize).toBeCloseTo(70, 4);

      // Position should still exist with reduced size
      const pos = await db.getPositionById(initial.positionId);
      expect(pos?.size).toBeCloseTo(70, 4);
      expect(pos?.closedAt).toBeNull();
    });

    it('closes position when opening opposite side with equal size', async () => {
      // Open LONG position
      const initial = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Open opposite side with exact same size - should close
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'short',
        size: 100,
        leverage: 10,
      });

      expect(result.isRebalance).toBe(true);
      expect(result.rebalanceType).toBe('close');
      expect(result.fullyClosed).toBe(true);

      // Position should be closed
      const pos = await db.getPositionById(initial.positionId);
      expect(pos?.closedAt).toBeDefined();
    });

    it('flips position when opening opposite side with larger size', async () => {
      // Open LONG position of 100
      const initial = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Open SHORT with larger size - should flip
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'short',
        size: 150,
        leverage: 10,
      });

      expect(result.isRebalance).toBe(true);
      expect(result.rebalanceType).toBe('flip');
      expect(result.side).toBe('short');
      // New position size should be 150 - 100 = 50
      expect(result.size).toBe(50);

      // Original position should be closed
      const oldPos = await db.getPositionById(initial.positionId);
      expect(oldPos?.closedAt).toBeDefined();

      // New position should exist
      const positions = await db.getOpenPositionsByUser('u3');
      expect(positions.length).toBe(1);
      expect(positions[0]?.side).toBe('short');
      expect(positions[0]?.size).toBe(50);
    });

    it('uses existing leverage when adding to position', async () => {
      // Open with 10x leverage
      await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      // Try to add with 5x leverage - should use existing 10x
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 5, // This should be ignored
      });

      expect(result.leverage).toBe(10); // Uses existing leverage
    });

    it('charges fees only on added size, not total position', async () => {
      await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      const balanceAfterFirst = (await wallet.getBalance('u3')).balance;

      // Add more to position
      const result = await service.openPosition({
        userId: 'u3',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      const balanceAfterSecond = (await wallet.getBalance('u3')).balance;

      // Fee should be 0.1% of 100 (added size) = 0.1
      // Margin should be 100/10 = 10
      // Total deducted = 10.1
      expect(balanceAfterFirst - balanceAfterSecond).toBeCloseTo(10.1, 4);
      expect(result.feePaid).toBeCloseTo(0.1, 4);
    });
  });

  it('allows different users to open positions on same ticker', async () => {
    await service.openPosition({
      userId: 'u4',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    // Different user should be able to open position
    const pos2 = await service.openPosition({
      userId: 'u5',
      ticker: 'ABC',
      side: 'short',
      size: 50,
      leverage: 5,
    });

    expect(pos2.positionId).toBeDefined();
  });

  it('rejects trading on top of an invalid persisted open position', async () => {
    const now = new Date();

    await db.upsertPosition({
      id: 'pos-corrupt',
      userId: 'u-corrupt',
      ticker: 'ABC',
      organizationId: 'org-abc',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 2_000_000,
      leverage: 1,
      liquidationPrice: 50,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: now,
      lastUpdated: now,
      closedAt: null,
      realizedPnL: null,
    });

    await expect(
      service.openPosition({
        userId: 'u-corrupt',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 1,
      })
    ).rejects.toThrow(/Invalid persisted perp position state detected/);
  });

  describe('money-path regressions', () => {
    /**
     * Price impact port that prices the market from the net open holdings,
     * mirroring the production adapter (constant-product reserves).
     */
    function createImpactPort(basePrice: number): PriceImpactPort {
      return {
        async getBasePrice() {
          return basePrice;
        },
        async applyAndGetPrice(ticker: string) {
          const net = (await db.listOpenPositions())
            .filter((p) => p.ticker === ticker)
            .reduce(
              (sum, p) => sum + (p.side === 'long' ? p.size : -p.size),
              0
            );
          const price = calculateRawPriceFromHoldings(
            basePrice,
            net,
            PERP_MARKET_CONFIG
          );
          await db.updateMarketStats(ticker, { currentPrice: price });
          return price;
        },
      };
    }

    it('charges funding to shorts when shorts dominate open interest', async () => {
      await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 50,
        leverage: 10,
      });
      await service.openPosition({
        userId: 'u2',
        ticker: 'ABC',
        side: 'short',
        size: 100,
        leverage: 10,
      });

      await service.processFundingAndLiquidations();

      const positions = await db.listOpenPositions();
      const longPos = positions.find((p) => p.userId === 'u1');
      const shortPos = positions.find((p) => p.userId === 'u2');
      // Shorts pay (positive fundingPaid), longs receive (negative)
      expect(shortPos?.fundingPaid ?? 0).toBeGreaterThan(0);
      expect(longPos?.fundingPaid ?? 0).toBeLessThan(0);
    });

    it('charges no funding when open interest is balanced', async () => {
      await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });
      await service.openPosition({
        userId: 'u2',
        ticker: 'ABC',
        side: 'short',
        size: 100,
        leverage: 10,
      });

      await service.processFundingAndLiquidations();

      for (const pos of await db.listOpenPositions()) {
        expect(pos.fundingPaid).toBe(0);
      }
    });

    it('keeps the weighted cost basis when adding at a different price', async () => {
      const basePrice = 100;
      service = new PerpMarketService({
        db,
        wallet,
        fees: feeConfig,
        priceImpact: createImpactPort(basePrice),
      });

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

      const incrementalFill = calculateTradeImpact(
        basePrice,
        1000,
        1000,
        PERP_MARKET_CONFIG
      ).avgFillPrice;
      const expectedEntry =
        (1000 * first.entryPrice + 1000 * incrementalFill) / 2000;

      expect(incrementalFill).not.toBeCloseTo(first.entryPrice, 6);
      expect(added.entryPrice).toBeCloseTo(expectedEntry, 6);
      const [pos] = await db.listOpenPositions();
      expect(pos?.entryPrice).toBeCloseTo(expectedEntry, 6);
      expect(pos?.size).toBe(2000);
    });

    it('rejects an open whose post-impact fill breaches maxSlippage', async () => {
      service = new PerpMarketService({
        db,
        wallet,
        fees: feeConfig,
        priceImpact: createImpactPort(100),
      });
      const fill = calculateTradeImpact(
        100,
        0,
        5000,
        PERP_MARKET_CONFIG
      ).avgFillPrice;
      // Tolerance below the actual impact but above zero
      const tolerance = ((fill - 100) / 100) * 0.5;

      await expect(
        service.openPosition({
          userId: 'u1',
          ticker: 'ABC',
          side: 'long',
          size: 5000,
          leverage: 10,
          maxSlippage: tolerance,
        })
      ).rejects.toThrow(/Slippage exceeded/);
      // Nothing moved
      expect((await wallet.getBalance('u1')).balance).toBe(10_000);
      expect(await db.listOpenPositions()).toHaveLength(0);
    });

    it('rejects invalid explicit close percentages instead of closing fully', async () => {
      const open = await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });

      for (const percentage of [0, -0.5, Number.NaN, 1.5]) {
        await expect(
          service.closePosition({
            userId: 'u1',
            positionId: open.positionId,
            percentage,
          })
        ).rejects.toThrow(/Close percentage/);
      }
      const [pos] = await db.listOpenPositions();
      expect(pos?.size).toBe(100);
    });

    it('does not mutate the caller price map when filtering invalid prices', async () => {
      const updates = new Map<string, number>([
        ['org-abc', 101],
        ['bad', Number.NaN],
      ]);
      const summary = await service.applyPriceUpdates(updates);
      expect(summary.errors).toHaveLength(1);
      expect(updates.size).toBe(2);
    });

    it('accumulates open-interest decrements across liquidations on one market', async () => {
      await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });
      await service.openPosition({
        userId: 'u2',
        ticker: 'ABC',
        side: 'long',
        size: 200,
        leverage: 10,
      });
      expect((await db.listMarkets())[0]?.openInterest).toBeCloseTo(300, 6);

      const summary = await service.applyPriceUpdates({ ABC: 50 });

      expect(summary.liquidations).toBe(2);
      expect((await db.listMarkets())[0]?.openInterest).toBeCloseTo(0, 6);
    });

    it('settles a flip with a single net wallet mutation', async () => {
      const calls: string[] = [];
      const trackingWallet: WalletPort = {
        debit: async (p) => {
          calls.push('debit');
          await wallet.debit(p);
        },
        credit: async (p) => {
          calls.push('credit');
          await wallet.credit(p);
        },
        recordPnL: async (p) => wallet.recordPnL(p),
        getBalance: async (u) => wallet.getBalance(u),
      };
      service = new PerpMarketService({
        db,
        wallet: trackingWallet,
        fees: feeConfig,
      });

      await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'long',
        size: 100,
        leverage: 10,
      });
      calls.length = 0;

      const flip = await service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'short',
        size: 300,
        leverage: 10,
      });

      expect(flip.rebalanceType).toBe('flip');
      expect(calls).toHaveLength(1);
      expect((await db.listMarkets())[0]?.openInterest).toBeCloseTo(200, 6);
    });
  });
});

describe('funding accrual vs a close landing mid-step', () => {
  const market: PerpMarketRecord = {
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
   * Port wrapper that models the interleaving the production adapters
   * allow: the funding step reads a snapshot of open positions, and a
   * user close can commit before the step writes its accrued funding
   * back. The first fundingPaid write for the target position first runs
   * a 50% close of that position through a separate service on the same
   * store (the close takes its own row lock, exactly like the real
   * closePosition path). If the funding step itself holds the position
   * lock (transaction + lockOpenPositionById), the close is deferred
   * until the step's write has landed — the serialization the drizzle
   * adapter's SELECT ... FOR UPDATE provides.
   */
  class InterleavingDb implements PerpDbPort {
    private lockedIds = new Set<string>();
    private interleaved = false;
    onFirstFundingWrite: (() => Promise<void>) | null = null;

    constructor(private inner: InMemoryPerpDb) {}

    async listMarkets(options?: { limit?: number; offset?: number }) {
      return this.inner.listMarkets(options);
    }
    async countMarkets() {
      return this.inner.countMarkets();
    }
    async listOpenPositions() {
      return this.inner.listOpenPositions();
    }
    async getPositionById(id: string) {
      return this.inner.getPositionById(id);
    }
    async getOpenPositionsByUser(userId: string) {
      return this.inner.getOpenPositionsByUser(userId);
    }
    async getOpenPositionByUserAndTicker(userId: string, ticker: string) {
      return this.inner.getOpenPositionByUserAndTicker(userId, ticker);
    }
    async lockOpenPositionById(id: string) {
      const pos = await this.inner.lockOpenPositionById(id);
      if (pos) this.lockedIds.add(id);
      return pos;
    }
    async upsertPosition(
      position: Omit<PerpPositionRecord, 'id'> & { id?: string }
    ) {
      return this.inner.upsertPosition(position);
    }
    async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T> {
      try {
        return await fn(this);
      } finally {
        this.lockedIds.clear();
      }
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
      const isFundingWrite =
        updates.fundingPaid !== undefined &&
        this.onFirstFundingWrite !== null &&
        !this.interleaved;
      if (isFundingWrite) {
        this.interleaved = true;
        if (this.lockedIds.has(positionId)) {
          // The step holds the row lock: the close can only run after
          // this write commits, so apply the write first, then close.
          await this.inner.updateOpenPosition(positionId, updates);
          await this.onFirstFundingWrite!();
          return;
        }
        // No lock held: the close commits first, then the (stale) write.
        await this.onFirstFundingWrite!();
      }
      return this.inner.updateOpenPosition(positionId, updates);
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
    ) {
      return this.inner.closePosition(positionId, updates);
    }
    async applyMarketDeltas(
      ticker: string,
      deltas: { openInterest?: number; volume24h?: number }
    ) {
      return this.inner.applyMarketDeltas(ticker, deltas);
    }
    async updateMarketStats(
      ticker: string,
      updates: Parameters<PerpDbPort['updateMarketStats']>[1]
    ) {
      return this.inner.updateMarketStats(ticker, updates);
    }
  }

  it('never resurrects funding a partial close already settled', async () => {
    const inner = new InMemoryPerpDb([market]);
    const wallet = new InMemoryWallet(10_000);
    const setup = new PerpMarketService({ db: inner, wallet, fees: feeConfig });

    // Long 200 vs short 100: imbalance 1/3, longs pay.
    // annualRate = 0.01 + 0.49 * (1/3)^3 = 0.028148..., period rate
    // = annualRate / 1095.75. One step accrues F1 = 200 * periodRate
    // = 0.0051375 on the long.
    const open = await setup.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 200,
      leverage: 10,
    });
    await setup.openPosition({
      userId: 'u2',
      ticker: 'ABC',
      side: 'short',
      size: 100,
      leverage: 10,
    });

    await setup.processFundingAndLiquidations();
    const afterFirst = await inner.getPositionById(open.positionId);
    const accrued = afterFirst?.fundingPaid ?? 0;
    expect(accrued).toBeGreaterThan(0);

    // Second step: a 50% close of the long lands while the step is
    // between its position snapshot and its funding write.
    const interleaving = new InterleavingDb(inner);
    const closer = new PerpMarketService({
      db: inner,
      wallet,
      fees: feeConfig,
    });
    interleaving.onFirstFundingWrite = async () => {
      await closer.closePosition({
        userId: 'u1',
        positionId: open.positionId,
        percentage: 0.5,
      });
    };
    const fundingService = new PerpMarketService({
      db: interleaving,
      wallet,
      fees: feeConfig,
    });
    await fundingService.processFundingAndLiquidations();

    const remaining = await inner.getPositionById(open.positionId);
    expect(remaining?.closedAt).toBeNull();
    expect(remaining?.size).toBeCloseTo(100, 6);
    // Either serialization (close-then-funding on the fresh size 100, or
    // funding-then-close settling half) leaves the remaining position
    // owing exactly one period's accrual: accrued/2 still owed from the
    // first step plus one period on the remaining 100 = accrued.
    // A stale read-modify-write instead lands accrued + accrued, i.e.
    // the settled half of the first accrual is charged a second time.
    expect(remaining?.fundingPaid).toBeCloseTo(accrued, 6);

    // The untouched short accrues its second period normally.
    const shorts = (await inner.listOpenPositions()).filter(
      (p) => p.userId === 'u2'
    );
    expect(shorts[0]?.fundingPaid).toBeCloseTo(-accrued, 6);
  });
});
