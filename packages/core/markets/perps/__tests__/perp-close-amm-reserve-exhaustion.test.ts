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
 * Repro: the constant-product AMM behind the close preview has a finite
 * implied quote reserve (INITIAL_BASE_RESERVE x base price = 5000 x $100 =
 * $500,000 at a $100 base price). Closing a LONG is a sell leg, and
 * calculateTradeImpact throws 'Trade exceeds available quote reserves' when
 * the sell removes more quote than the reserve holds. previewCloseImpact
 * rethrows that error, so closePosition rejects BEFORE any settlement — the
 * position stays open and the user cannot fully exit a position the service
 * itself allowed them to open (max position = 10% of OI can exceed the
 * $500k reserve once OI grows past $5M).
 *
 * The same throw escapes expectedOpenFill, so opening a SHORT with a
 * slippage cap rejects pre-commit for the same reason.
 *
 * This is distinct from #1615, which only catches failures at the four
 * POST-settlement impact call sites (applyPostTradeImpact /
 * applyPostCloseMarketImpact). The preview here runs pre-settlement, inside
 * closePosition's transaction, and #1615 does not touch it.
 */

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

class ReproWallet implements WalletPort {
  private balances = new Map<string, number>();

  constructor(private defaultBalance = 1_000_000) {}

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

class ReproDb implements PerpDbPort {
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
    return pos && !pos.closedAt ? { ...pos } : null;
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
    } as PerpPositionRecord;
    this.positions.set(id, record);
    return { ...record };
  }

  async updateOpenPosition(
    positionId: string,
    updates: Partial<PerpPositionRecord>
  ): Promise<void> {
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
  ): Promise<boolean> {
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
  ): Promise<{ openInterest: number; volume24h: number }> {
    const current = this.markets.get(ticker)!;
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
  // 10% of OI = $600k max position, above the $500k implied AMM quote
  // reserve (5000 base reserve x $100 base price).
  openInterest: 6_000_000,
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

// Valid pricing context (base price $100); the failure is the AMM math, not
// a missing port.
const impactPort: PriceImpactPort = {
  getBasePrice: async () => 100,
  applyAndGetPrice: async () => 100,
};

function makeService(db: ReproDb, wallet: ReproWallet) {
  return new PerpMarketService({
    settlement: {
      run: async (_userId, operation) =>
        db.transaction((tx) => operation(tx, wallet)),
    },
    db,
    wallet,
    fees: feeConfig,
    priceImpact: impactPort,
  });
}

describe('FEED repro: close preview fails when the sell exceeds the AMM quote reserve', () => {
  it('fully closes a long larger than the implied quote reserve', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet();
    const service = makeService(db, wallet);

    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 600_000,
      leverage: 1,
    });
    expect(open.positionId).toBeDefined();

    const closed = await service.closePosition({
      userId: 'u1',
      positionId: open.positionId,
    });

    expect(closed.fullyClosed).toBe(true);
    expect(closed.remainingSize).toBe(0);
    expect(await db.listOpenPositions()).toHaveLength(0);
    // Settlement was credited: balance recovered most of the $600k margin.
    expect((await wallet.getBalance('u1')).balance).toBeGreaterThan(500_000);
  });

  it('opens a short with a slippage cap when the sell exceeds the implied quote reserve', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet();
    const service = makeService(db, wallet);

    const open = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 600_000,
      leverage: 1,
      maxSlippage: 0.5,
    });

    expect(open.positionId).toBeDefined();
    expect(await db.listOpenPositions()).toHaveLength(1);
  });
});
