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

/**
 * Repro: the open/add/flip/reduce previews quote the synthetic
 * microstructure price, but execution settles at the constant-product AMM
 * average fill whenever a price-impact port is configured
 * (`applyPostTradeImpact` rewrites the entry, `previewCloseImpact`
 * rewrites the exit). The synthetic impact saturates at the 320 bps cap
 * while the AMM impact keeps growing with size, so for large orders the
 * previewed entry — and the liquidation price derived from it — can be
 * several percent off the fill the user actually gets. The preview's own
 * doc comment promises "the exact quote/execution engine used for opening
 * a position", and the existing test "uses the same execution engine for
 * open preview and open execution" only passes vacuously because its
 * service is built without a price-impact port.
 *
 * Fix: preview builders use the AMM average fill (`expectedOpenFill` for
 * open legs, `previewCloseImpact` for close legs) when a price-impact port
 * is configured, falling back to the synthetic quote otherwise — exactly
 * as the slippage checks already do.
 */

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

class InMemoryWallet implements WalletPort {
  private balances = new Map<string, number>();
  private pnls: Array<{ userId: string; pnl: number; reason: string }> = [];

  constructor(private defaultBalance = 100_000) {}

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

/**
 * Price impact port that prices the market from the net open holdings,
 * mirroring the production adapter (constant-product reserves). Same shape
 * as the port in PerpAddImpactPnL.test.ts.
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

describe('perp previews use the AMM fill when a price-impact port is configured', () => {
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
    volume24h: 50_000,
    openInterest: 20_000,
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
    wallet = new InMemoryWallet(100_000);
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

  it('open preview matches the executed AMM entry and liquidation price', async () => {
    const preview = await service.previewOpenPosition({
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });

    expect(preview.executionPrice).toBeCloseTo(open.entryPrice, 6);
    expect(preview.liquidationPrice).toBeCloseTo(open.liquidationPrice, 6);
  });

  it('add preview matches the executed incremental AMM fill and liquidation price', async () => {
    const first = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });
    const added = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });

    // The preview quotes the incremental fill; execution blends it with
    // the existing basis, so compare the preview fill to the AMM fill the
    // execution used and the liquidation price to the executed one.
    const incrementalFill = calculateTradeImpact(
      100,
      1000,
      5000,
      PERP_MARKET_CONFIG
    ).avgFillPrice;
    expect(preview.executionPrice).toBeCloseTo(incrementalFill, 6);
    expect(preview.liquidationPrice).toBeCloseTo(added.liquidationPrice, 6);
    expect(first.entryPrice).not.toBeCloseTo(added.entryPrice, 6);
  });

  it('flip preview matches the executed inverse-leg AMM entry and liquidation price', async () => {
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 1000,
      leverage: 10,
    });
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });
    const flipped = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });

    expect(preview.previewType).toBe('flip');
    expect(preview.executionPrice).toBeCloseTo(flipped.entryPrice, 6);
    expect(preview.liquidationPrice).toBeCloseTo(flipped.liquidationPrice, 6);
  });

  it('reduce preview matches the executed AMM exit fill and settlement', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 5000,
      leverage: 10,
    });
    const balanceBeforeClose = (await wallet.getBalance('u1')).balance;
    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 2500,
      leverage: 10,
    });
    const closed = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      percentage: 0.5,
    });

    expect(preview.previewType).toBe('reduce');
    expect(preview.estimatedClosePrice).toBeCloseTo(closed.exitPrice!, 6);
    const credited =
      (await wallet.getBalance('u1')).balance - balanceBeforeClose;
    expect(preview.estimatedCloseSettlement).toBeCloseTo(credited, 6);
  });
});
