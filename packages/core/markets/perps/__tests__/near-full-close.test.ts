import { beforeEach, describe, expect, it } from 'bun:test';
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
    for (const market of initialMarkets) {
      this.markets.set(market.ticker, { ...market });
    }
  }

  async listMarkets(): Promise<PerpMarketRecord[]> {
    return Array.from(this.markets.values()).map((market) => ({ ...market }));
  }

  async countMarkets(): Promise<number> {
    return this.markets.size;
  }

  async listOpenPositions(): Promise<PerpPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((position) => !position.closedAt)
      .map((position) => ({ ...position }));
  }

  async getPositionById(id: string): Promise<PerpPositionRecord | null> {
    const position = this.positions.get(id);
    return position ? { ...position } : null;
  }

  async getOpenPositionsByUser(userId: string): Promise<PerpPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((position) => position.userId === userId && !position.closedAt)
      .map((position) => ({ ...position }));
  }

  async getOpenPositionByUserAndTicker(
    userId: string,
    ticker: string
  ): Promise<PerpPositionRecord | null> {
    const position = Array.from(this.positions.values()).find(
      (entry) =>
        entry.userId === userId && entry.ticker === ticker && !entry.closedAt
    );
    return position ? { ...position } : null;
  }

  async lockOpenPositionById(id: string): Promise<PerpPositionRecord | null> {
    const position = this.positions.get(id);
    if (!position || position.closedAt) return null;
    return { ...position };
  }

  async claimFundingPeriod(): Promise<boolean> {
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
      ...position,
      id,
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
        | 'realizedPnL'
      >
    >
  ): Promise<void> {
    const position = this.positions.get(positionId);
    if (!position || position.closedAt) return;
    this.positions.set(positionId, { ...position, ...updates });
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
    const position = this.positions.get(positionId);
    if (!position || position.closedAt) return false;
    this.positions.set(positionId, {
      ...position,
      closedAt: updates.closedAt ?? new Date(),
      currentPrice: updates.currentPrice ?? position.currentPrice,
      realizedPnL: updates.realizedPnL ?? position.realizedPnL,
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
    this.markets.set(ticker, { ...current, ...updates });
  }
}

describe('PerpMarketService near-full close settlement and tolerance alignment', () => {
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
    maxLeverage: 20,
    minOrderSize: 10,
    markPrice: 100,
    indexPrice: 100,
  };

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
    });
  });

  it('settles full size, margin, funding, and open interest when a near-full partial close triggers full close', async () => {
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 2,
    });
    await db.updateOpenPosition(opened.positionId, { fundingPaid: 20 });

    const closed = await service.closePosition({
      userId: 'u1',
      positionId: opened.positionId,
      percentage: 0.99995,
      exitPriceOverride: opened.entryPrice,
    });

    expect(closed.fullyClosed).toBe(true);
    expect(closed.remainingSize).toBe(0);
    expect(closed.size).toBe(100);
    expect(closed.marginPaid).toBe(50);
    expect(closed.realizedPnL).toBe(-20);

    const [market] = await db.listMarkets();
    expect(market?.openInterest).toBe(0);
    expect(await db.getOpenPositionsByUser('u1')).toHaveLength(0);

    const expectedFinalBalance = 10_000 - opened.feePaid - closed.feePaid - 20;
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(
      expectedFinalBalance,
      10
    );
  });

  it('treats an opposite-side order within 0.01 below existing size as a full close in both preview and execution', async () => {
    const opened = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 2,
    });
    await db.updateOpenPosition(opened.positionId, { fundingPaid: 10 });

    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 99.995,
      leverage: 2,
    });
    expect(preview.previewType).toBe('close');
    expect(preview.rebalanceType).toBe('close');
    expect(preview.size).toBe(100);
    expect(preview.resultingSize).toBe(0);
    expect(preview.liquidationPrice).toBe(0);

    const closed = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 99.995,
      leverage: 2,
    });
    expect(closed.rebalanceType).toBe('close');
    expect(closed.fullyClosed).toBe(true);
    expect(closed.remainingSize).toBe(0);
    expect(closed.size).toBe(100);
    expect(closed.marginPaid).toBe(50);

    const [market] = await db.listMarkets();
    expect(market?.openInterest).toBe(0);
    expect(await db.getOpenPositionsByUser('u1')).toHaveLength(0);

    await service.openPosition({
      userId: 'u2',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 2,
    });
    const abovePreview = await service.previewOrder({
      userId: 'u2',
      ticker: 'ABC',
      side: 'short',
      size: 100.005,
      leverage: 2,
    });
    expect(abovePreview.rebalanceType).toBe('close');
    expect(abovePreview.resultingSize).toBe(0);

    const aboveClosed = await service.openPosition({
      userId: 'u2',
      ticker: 'ABC',
      side: 'short',
      size: 100.005,
      leverage: 2,
    });
    expect(aboveClosed.rebalanceType).toBe('close');
    expect(aboveClosed.fullyClosed).toBe(true);
    expect(aboveClosed.size).toBe(100);
  });

  it('keeps an opposite-side order leaving at least 0.01 remaining as a partial reduce in both preview and execution', async () => {
    await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 2,
    });

    const preview = await service.previewOrder({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 99.99,
      leverage: 2,
    });
    expect(preview.previewType).toBe('reduce');
    expect(preview.rebalanceType).toBe('reduce');
    expect(preview.size).toBe(99.99);
    expect(preview.resultingSize).toBeCloseTo(0.01, 10);

    const reduced = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 99.99,
      leverage: 2,
    });
    expect(reduced.rebalanceType).toBe('reduce');
    expect(reduced.fullyClosed).toBe(false);
    expect(reduced.remainingSize).toBeCloseTo(0.01, 10);

    const [market] = await db.listMarkets();
    expect(market?.openInterest).toBeCloseTo(0.01, 10);
    expect(await db.getOpenPositionsByUser('u1')).toHaveLength(1);
  });
});
