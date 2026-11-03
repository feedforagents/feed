/**
 * Regression: closePosition reopens when settlement credit fails.
 * FEED-L5: PerpMarketService.closePosition settles (closes position) inside a
 * DB transaction, THEN wallet.credit outside. If credit throws, position is
 * gone and settlement is never paid → permanent strand.
 * Distinct from #1556/#1577/#1590 (all debit-first paths).
 */
import { describe, expect, it } from 'bun:test';
import {
  WalletCreditNotAppliedError,
  type WalletPort,
} from '../../shared/common';
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

class FlakyCreditWallet implements WalletPort {
  private balances = new Map<string, number>();
  creditCalls = 0;
  failCredits = true;
  timeoutAfterApply = false;
  timeoutBeforeApply = false;
  beforeNotApplied: (() => void) | null = null;
  constructor(private defaultBalance = 10_000) {}
  async debit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
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
  }): Promise<void> {
    this.creditCalls++;
    if (this.timeoutBeforeApply) {
      throw new Error('credit timeout');
    }
    if (this.failCredits) {
      this.beforeNotApplied?.();
      throw new WalletCreditNotAppliedError('wallet credit failed');
    }
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, balance + amount);
    if (this.timeoutAfterApply) {
      throw new Error('credit timeout');
    }
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
  async lockPositionById(id: string): Promise<PerpPositionRecord | null> {
    const pos = this.positions.get(id);
    return pos ? { ...pos } : null;
  }
  forcePatch(id: string, updates: Partial<PerpPositionRecord>): void {
    const pos = this.positions.get(id);
    if (!pos) throw new Error(`missing position ${id}`);
    this.positions.set(id, { ...pos, ...updates });
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
    updates: Partial<PerpPositionRecord>
  ): Promise<void> {
    const pos = this.positions.get(positionId);
    if (!pos || pos.closedAt) return;
    this.positions.set(positionId, {
      ...pos,
      ...updates,
      lastUpdated: (updates.lastUpdated as Date) ?? new Date(),
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
      closedAt: (updates.closedAt as Date) ?? new Date(),
      currentPrice: (updates.currentPrice as number) ?? pos.currentPrice,
      realizedPnL: (updates.realizedPnL as number) ?? pos.realizedPnL,
      unrealizedPnL: (updates.unrealizedPnL as number) ?? 0,
      unrealizedPnLPercent: (updates.unrealizedPnLPercent as number) ?? 0,
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
  async updateMarketStats(): Promise<void> {}
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
  openInterest: 100,
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

describe('FEED-L5 closePosition credit-fail compensation', () => {
  it('reopens the position when settlement credit is not applied', async () => {
    const wallet = new FlakyCreditWallet(0);
    // Start with 0 balance (margin already locked in position conceptually)
    wallet['balances'].set('u1', 0);
    const db = new InMemoryPerpDb([baseMarket]);
    const now = new Date();
    const position = await db.upsertPosition({
      userId: 'u1',
      ticker: 'ABC',
      organizationId: 'org-abc',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 100,
      leverage: 10,
      liquidationPrice: 90,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: now,
      lastUpdated: now,
    });

    const service = new PerpMarketService({
      db,
      wallet,
      fees: feeConfig,
    });

    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('wallet credit failed');

    const after = await db.getPositionById(position.id);
    // Compensating reopen keeps the position open when credit fails
    expect(after?.closedAt).toBeFalsy();
    expect((await db.listOpenPositions()).length).toBe(1);
    expect((await wallet.getBalance('u1')).balance).toBe(0);
    // Retry close can proceed once credit works
    wallet.failCredits = false;
    const result = await service.closePosition({
      userId: 'u1',
      positionId: position.id,
    });
    expect(result.positionId).toBe(position.id);
    expect((await db.getPositionById(position.id))?.closedAt).toBeTruthy();
    expect((await wallet.getBalance('u1')).balance).toBeGreaterThan(0);
    const market = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    // Failed attempt reversed its volume; the successful close records it once.
    expect(market?.openInterest).toBe(0);
    expect(market?.volume24h).toBe(position.size);
  });

  it('reverses volume24h when a failed credit reopens the position', async () => {
    const { service, db, position } = await seededClose();
    const before = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('wallet credit failed');
    const after = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    expect(after?.volume24h).toBe(before?.volume24h);
    expect(after?.openInterest).toBe(before?.openInterest);
    expect((await db.getPositionById(position.id))?.closedAt).toBeFalsy();
  });

  it('restores partial-close mark-to-market when credit is not applied', async () => {
    const { service, db, position } = await seededClose({
      unrealizedPnL: 42,
      unrealizedPnLPercent: 3.5,
      fundingPaid: 1.25,
    });
    await expect(
      service.closePosition({
        userId: 'u1',
        positionId: position.id,
        percentage: 0.5,
        exitPriceOverride: 110,
      })
    ).rejects.toThrow('wallet credit failed');
    const after = await db.getPositionById(position.id);
    expect(after?.closedAt).toBeFalsy();
    expect(after?.size).toBe(100);
    expect(after?.fundingPaid).toBe(1.25);
    expect(after?.unrealizedPnL).toBe(42);
    expect(after?.unrealizedPnLPercent).toBe(3.5);
    const market = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    expect(market?.volume24h).toBe(0);
    expect(market?.openInterest).toBe(100);
  });

  it('refuses to reopen when the position changed after the close', async () => {
    const wallet = new FlakyCreditWallet(0);
    wallet['balances'].set('u1', 0);
    const db = new InMemoryPerpDb([baseMarket]);
    const position = await seedPosition(db, { fundingPaid: 1 });
    wallet.beforeNotApplied = () => {
      db.forcePatch(position.id, { fundingPaid: 99 });
    };
    const service = new PerpMarketService({ db, wallet, fees: feeConfig });
    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('wallet credit failed');
    const after = await db.getPositionById(position.id);
    expect(after?.closedAt).toBeTruthy();
    expect(after?.fundingPaid).toBe(99);
    const market = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    expect(market?.volume24h).toBe(position.size);
    expect(market?.openInterest).toBe(baseMarket.openInterest - position.size);
  });

  it('does not reopen when a timeout follows an applied credit', async () => {
    const wallet = new FlakyCreditWallet(0);
    wallet['balances'].set('u1', 0);
    wallet.failCredits = false;
    wallet.timeoutAfterApply = true;
    const db = new InMemoryPerpDb([baseMarket]);
    const position = await seedPosition(db);
    const service = new PerpMarketService({ db, wallet, fees: feeConfig });
    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('credit timeout');
    const after = await db.getPositionById(position.id);
    expect(after?.closedAt).toBeTruthy();
    const paid = (await wallet.getBalance('u1')).balance;
    expect(paid).toBeGreaterThan(0);
    expect(wallet.creditCalls).toBe(1);
    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('already closed');
    expect(wallet.creditCalls).toBe(1);
    expect((await wallet.getBalance('u1')).balance).toBe(paid);
  });

  it('reopens when a timeout happens before the credit is applied', async () => {
    const wallet = new FlakyCreditWallet(0);
    wallet['balances'].set('u1', 0);
    wallet.timeoutBeforeApply = true;
    const db = new InMemoryPerpDb([baseMarket]);
    const position = await seedPosition(db);
    const service = new PerpMarketService({ db, wallet, fees: feeConfig });
    await expect(
      service.closePosition({ userId: 'u1', positionId: position.id })
    ).rejects.toThrow('credit timeout');
    expect((await db.getPositionById(position.id))?.closedAt).toBeFalsy();
    expect((await wallet.getBalance('u1')).balance).toBe(0);
    const market = (await db.listMarkets()).find((m) => m.ticker === 'ABC');
    expect(market?.volume24h).toBe(0);
    expect(market?.openInterest).toBe(baseMarket.openInterest);
  });
});

async function seedPosition(
  db: InMemoryPerpDb,
  overrides: Partial<PerpPositionRecord> = {}
): Promise<PerpPositionRecord> {
  const now = new Date();
  return db.upsertPosition({
    userId: 'u1',
    ticker: 'ABC',
    organizationId: 'org-abc',
    side: 'long',
    entryPrice: 100,
    currentPrice: 100,
    size: 100,
    leverage: 10,
    liquidationPrice: 90,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    fundingPaid: 0,
    openedAt: now,
    lastUpdated: now,
    ...overrides,
  });
}

async function seededClose(
  overrides: Partial<PerpPositionRecord> = {}
): Promise<{
  service: PerpMarketService;
  db: InMemoryPerpDb;
  wallet: FlakyCreditWallet;
  position: PerpPositionRecord;
}> {
  const wallet = new FlakyCreditWallet(0);
  wallet['balances'].set('u1', 0);
  const db = new InMemoryPerpDb([{ ...baseMarket }]);
  const position = await seedPosition(db, overrides);
  const service = new PerpMarketService({ db, wallet, fees: feeConfig });
  return { service, db, wallet, position };
}
