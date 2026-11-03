/**
 * Regression: flip settles wallet LAST inside the DB TX callback; recordPnL
 * runs only after commit. Wallet is not enlisted in the DB TX, so a throw
 * AFTER a successful credit/debit would mint/strand against a rolled-back
 * flip. Keeping the net mutation last means a debit failure aborts the
 * callback (no committed-but-unpaid inverse). recordPnL after commit must
 * not gate settle. Distinct from #1556/#1577/#1590.
 */
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

class WalletWithThrowingPnL implements WalletPort {
  private balances = new Map<string, number>();
  debitCalls = 0;
  creditCalls = 0;
  lastDebit = 0;
  throwOnPnL = true;
  failNextDebit = false;
  constructor(private defaultBalance = 10_000) {}
  async debit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
  }): Promise<void> {
    this.debitCalls++;
    this.lastDebit = amount;
    if (this.failNextDebit) {
      this.failNextDebit = false;
      throw new Error('Insufficient funds');
    }
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
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, balance + amount);
  }
  async recordPnL(): Promise<void> {
    if (this.throwOnPnL) throw new Error('recordPnL failed');
  }
  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class RollbackAwarePerpDb implements PerpDbPort {
  private markets = new Map<string, PerpMarketRecord>();
  private positions = new Map<string, PerpPositionRecord>();
  private idCounter = 1;
  /** Snapshot stack to simulate DB rollback when callback throws */
  private snapshots: Array<{
    markets: Map<string, PerpMarketRecord>;
    positions: Map<string, PerpPositionRecord>;
    idCounter: number;
  }> = [];
  constructor(initialMarkets: PerpMarketRecord[]) {
    initialMarkets.forEach((m) => this.markets.set(m.ticker, { ...m }));
  }
  private cloneState() {
    return {
      markets: new Map(
        Array.from(this.markets.entries()).map(([k, v]) => [k, { ...v }])
      ),
      positions: new Map(
        Array.from(this.positions.entries()).map(([k, v]) => [k, { ...v }])
      ),
      idCounter: this.idCounter,
    };
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
    const snap = this.cloneState();
    this.snapshots.push(snap);
    try {
      const result = await fn(this);
      this.snapshots.pop();
      return result;
    } catch (err) {
      const rolled = this.snapshots.pop()!;
      this.markets = rolled.markets;
      this.positions = rolled.positions;
      this.idCounter = rolled.idCounter;
      throw err;
    }
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

describe('FEED-L7 flip wallet-last-in-tx', () => {
  it('keeps flip + debit when recordPnL throws after commit', async () => {
    const wallet = new WalletWithThrowingPnL(10_000);
    const db = new RollbackAwarePerpDb([baseMarket]);
    const now = new Date();
    // Existing LONG size 100. Flip with SHORT size 200 → close 100 + open inverse 100.
    // Close settlement ≈ margin 10 - fee 0.1 = 9.9; open cost = margin 10 + fee 0.1 = 10.1
    // walletNet = 9.9 - 10.1 = -0.2 → debit path
    await db.upsertPosition({
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

    const before = (await wallet.getBalance('u1')).balance;
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'short',
        size: 200,
        leverage: 10,
      })
    ).rejects.toThrow('recordPnL failed');

    const after = (await wallet.getBalance('u1')).balance;
    const openPositions = await db.listOpenPositions();
    // DB commit finished before recordPnL; flip sticks with matching wallet debit
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]?.side).toBe('short');
    expect(after).toBeLessThan(before);
    expect(wallet.debitCalls).toBe(1);
  });

  it('keeps flip + credit when recordPnL throws after commit (no free mint)', async () => {
    const wallet = new WalletWithThrowingPnL(10_000);
    const db = new RollbackAwarePerpDb([baseMarket]);
    const now = new Date();
    // Large long 200; flip short 210 → close 200 + open inverse 10; walletNet > 0
    await db.upsertPosition({
      userId: 'u1',
      ticker: 'ABC',
      organizationId: 'org-abc',
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 200,
      leverage: 10,
      liquidationPrice: 90,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: now,
      lastUpdated: now,
    });
    const service = new PerpMarketService({ db, wallet, fees: feeConfig });
    const before = (await wallet.getBalance('u1')).balance;
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'short',
        size: 210,
        leverage: 10,
      })
    ).rejects.toThrow('recordPnL failed');
    const after = (await wallet.getBalance('u1')).balance;
    const openPositions = await db.listOpenPositions();
    // No free-money mint against a rolled-back long: flip committed with credit
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]?.side).toBe('short');
    expect(after).toBeGreaterThan(before);
    expect(wallet.creditCalls).toBe(1);
  });

  it('rolls back the flip when the net debit fails (no unpaid inverse)', async () => {
    const wallet = new WalletWithThrowingPnL(10_000);
    wallet.throwOnPnL = false;
    wallet.failNextDebit = true;
    const db = new RollbackAwarePerpDb([baseMarket]);
    const now = new Date();
    await db.upsertPosition({
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
    const service = new PerpMarketService({ db, wallet, fees: feeConfig });
    const before = (await wallet.getBalance('u1')).balance;
    await expect(
      service.openPosition({
        userId: 'u1',
        ticker: 'ABC',
        side: 'short',
        size: 200,
        leverage: 10,
      })
    ).rejects.toThrow('Insufficient funds');
    const after = (await wallet.getBalance('u1')).balance;
    const openPositions = await db.listOpenPositions();
    // Debit failed last-in-TX → callback threw → DB rolled back. Original long
    // restored; no committed-but-unpaid short.
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]?.side).toBe('long');
    expect(openPositions[0]?.size).toBe(100);
    expect(after).toBe(before);
    expect(wallet.debitCalls).toBe(1);
    expect(wallet.creditCalls).toBe(0);
  });
});
