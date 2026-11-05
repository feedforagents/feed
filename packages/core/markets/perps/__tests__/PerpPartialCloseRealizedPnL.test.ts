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
        | 'realizedPnL'
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

describe('PerpMarketService partial-close realized PnL record', () => {
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
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
    });
  });

  it('accumulates partial-close realized PnL into the position record', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', { currentPrice: 120 });

    const leg1 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      percentage: 0.5,
    });
    expect(leg1.fullyClosed).toBe(false);
    // Sanity: leg PnL matches the fill the service reports.
    const leg1Expected =
      ((leg1.exitPrice! - open.entryPrice) / open.entryPrice) * leg1.size;
    expect(leg1.realizedPnL).toBeCloseTo(leg1Expected, 4);
    expect(leg1.realizedPnL!).toBeGreaterThan(0);

    // The still-open position record must already carry the realized leg,
    // like every other close path accumulates into position.realizedPnL.
    const afterPartial = await db.getPositionById(open.positionId);
    expect(afterPartial?.realizedPnL ?? null).toBeCloseTo(leg1.realizedPnL!, 4);

    const leg2 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });
    expect(leg2.fullyClosed).toBe(true);
    const leg2Expected =
      ((leg2.exitPrice! - open.entryPrice) / open.entryPrice) * leg2.size;
    expect(leg2.realizedPnL).toBeCloseTo(leg2Expected, 4);

    // Closed record total = sum of the legs actually paid out.
    const closed = await db.getPositionById(open.positionId);
    expect(closed?.closedAt).toBeDefined();
    expect(closed?.realizedPnL ?? null).toBeCloseTo(
      leg1.realizedPnL! + leg2.realizedPnL!,
      4
    );
  });

  it('keeps the record net-positive when a winning partial leg outweighs a losing final leg', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', { currentPrice: 120 });
    const leg1 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      percentage: 0.5,
    });
    expect(leg1.realizedPnL!).toBeGreaterThan(0);

    await db.updateMarketStats('ABC', { currentPrice: 96 });
    const leg2 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });
    expect(leg2.realizedPnL!).toBeLessThan(0);
    // The winning partial leg outweighs the losing final leg.
    expect(leg1.realizedPnL! + leg2.realizedPnL!).toBeGreaterThan(0);

    // Consumers summing position.realizedPnL over closed positions (e.g. the
    // weekly_positive_pnl achievement) must see the net of both legs.
    const closed = await db.getPositionById(open.positionId);
    expect(closed?.realizedPnL ?? null).toBeCloseTo(
      leg1.realizedPnL! + leg2.realizedPnL!,
      4
    );
    expect(closed?.realizedPnL ?? 0).toBeGreaterThan(0);
  });

  it('does not change wallet settlement amounts across the two legs', async () => {
    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 10,
    });

    await db.updateMarketStats('ABC', { currentPrice: 120 });
    const leg1 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
      percentage: 0.5,
    });
    const leg2 = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });

    const balance = await wallet.getBalance('u1');
    const expectedBalance =
      10_000 -
      (open.marginPaid! + open.feePaid) +
      ((leg1.marginPaid ?? 0) + leg1.realizedPnL! - leg1.feePaid) +
      ((leg2.marginPaid ?? 0) + leg2.realizedPnL! - leg2.feePaid);
    expect(balance.balance).toBeCloseTo(expectedBalance, 4);
  });
});
