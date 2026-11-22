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
    this.balances.set(
      userId,
      (this.balances.get(userId) ?? this.defaultBalance) + amount
    );
  }

  async recordPnL(): Promise<void> {}

  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
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
        | 'price24hAgo'
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

const NOW = new Date('2026-11-05T00:00:00.000Z');
const NEXT_FUNDING = '2026-11-05T08:00:00.000Z';

function marketWith(
  ticker: string,
  fundingRate: PerpMarketRecord['fundingRate']
): PerpMarketRecord {
  return {
    ticker,
    organizationId: `org-${ticker.toLowerCase()}`,
    name: `${ticker} Corp`,
    currentPrice: 100,
    change24h: 0,
    changePercent24h: 0,
    high24h: 100,
    low24h: 100,
    volume24h: 0,
    openInterest: 0,
    fundingRate,
    maxLeverage: 20,
    minOrderSize: 10,
    markPrice: 100,
    indexPrice: 100,
  };
}

function makeService(db: InMemoryPerpDb): PerpMarketService {
  const wallet = new InMemoryWallet(10_000);
  return new PerpMarketService({
    settlement: {
      run: async (_userId, operation) =>
        db.transaction((tx) => operation(tx, wallet)),
    },
    db,
    wallet,
    fees: feeConfig,
    clock: { now: () => new Date(NOW) },
  });
}

describe('processFundingStep funding terms for markets without positions', () => {
  it('refreshes rate and nextFundingTime for a market with no open positions', async () => {
    // Terms left over from a period when shorts dominated: the market page
    // and API would show -50% APR and a next funding time in the past.
    const db = new InMemoryPerpDb([
      marketWith('ABC', {
        ticker: 'ABC',
        rate: -0.5,
        nextFundingTime: '2026-11-04T00:00:00.000Z',
        predictedRate: -0.5,
      }),
    ]);
    const service = makeService(db);

    await service.processFundingStep();

    const market = (await db.listMarkets())[0]!;
    // Zero open interest means the funding calculator's own base terms:
    // 1% APR, balanced, and the next scheduled funding 8h after the step.
    expect(market.fundingRate.rate).toBe(0.01);
    expect(market.fundingRate.predictedRate).toBe(0.01);
    expect(market.fundingRate.nextFundingTime).toBe(NEXT_FUNDING);
  });

  it('still charges and refreshes a market that has open positions', async () => {
    const db = new InMemoryPerpDb([
      marketWith('XYZ', {
        ticker: 'XYZ',
        rate: 0,
        nextFundingTime: '2026-11-04T00:00:00.000Z',
        predictedRate: 0,
      }),
    ]);
    await db.upsertPosition({
      userId: 'u1',
      ticker: 'XYZ',
      organizationId: 'org-xyz',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 100,
      leverage: 10,
      liquidationPrice: 90,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: NOW,
      lastUpdated: NOW,
      closedAt: null,
      realizedPnL: null,
    });
    const service = makeService(db);

    await service.processFundingStep();

    // A lone long is maximally imbalanced: longs pay at the 50% APR cap.
    const pos = (await db.listOpenPositions())[0]!;
    expect(pos.fundingPaid).toBeGreaterThan(0);
    expect(pos.fundingPaid).toBeCloseTo(100 * (0.5 / 1095.75), 8);

    const market = (await db.listMarkets())[0]!;
    expect(market.fundingRate.rate).toBe(0.5);
    expect(market.fundingRate.nextFundingTime).toBe(NEXT_FUNDING);
  });

  it('charges an open position once per 8h period, not once per run', async () => {
    const db = new InMemoryPerpDb([
      marketWith('XYZ', {
        ticker: 'XYZ',
        rate: 0,
        nextFundingTime: '2026-11-04T00:00:00.000Z',
        predictedRate: 0,
      }),
    ]);
    await db.upsertPosition({
      userId: 'u1',
      ticker: 'XYZ',
      organizationId: 'org-xyz',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 100,
      leverage: 10,
      liquidationPrice: 90,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: NOW,
      lastUpdated: NOW,
      closedAt: null,
      realizedPnL: null,
    });
    let now = new Date(NOW);
    const wallet = new InMemoryWallet(10_000);
    const service = new PerpMarketService({
      settlement: {
        run: async (_userId, operation) =>
          db.transaction((tx) => operation(tx, wallet)),
      },
      db,
      wallet,
      fees: feeConfig,
      clock: { now: () => now },
    });

    await service.processFundingStep();
    const once = (await db.listOpenPositions())[0]!.fundingPaid;
    const onePeriod = 100 * (0.5 / 1095.75);
    expect(once).toBeCloseTo(onePeriod, 8);

    // A redelivered cron, fan-out, or manual replay inside the same 8h window.
    await service.processFundingStep();
    expect((await db.listOpenPositions())[0]!.fundingPaid).toBeCloseTo(once, 8);

    now = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);
    await service.processFundingStep();
    expect((await db.listOpenPositions())[0]!.fundingPaid).toBeCloseTo(
      onePeriod * 2,
      8
    );
  });
});
