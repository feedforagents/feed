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

class ReproWallet implements WalletPort {
  private balances = new Map<string, number>();
  private pnls: Array<{ userId: string; pnl: number; reason: string }> = [];
  failRecordPnL = false;
  failGetBalance = false;

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
    if (this.failRecordPnL) throw new Error('PnL backend down');
    this.pnls.push({ userId, pnl, reason });
  }

  async getBalance(userId: string): Promise<{ balance: number }> {
    if (this.failGetBalance) throw new Error('Balance read down');
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }

  /** Read the balance without going through the failing getBalance path. */
  peekBalance(userId: string): number {
    return this.balances.get(userId) ?? this.defaultBalance;
  }

  getPnLs(userId: string) {
    return this.pnls.filter((p) => p.userId === userId);
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

function buildService(db: ReproDb, wallet: ReproWallet) {
  return new PerpMarketService({
    settlement: {
      run: async (_userId, operation) =>
        db.transaction((tx) => operation(tx, wallet)),
    },
    db,
    wallet,
    fees: feeConfig,
  });
}

async function openLong(service: PerpMarketService, size = 100, userId = 'u1') {
  return service.openPosition({
    userId,
    ticker: 'ABC',
    side: 'long',
    size,
    leverage: 10,
  });
}

/**
 * REPRO (candidate 1): closePosition awaits wallet.recordPnL AFTER the close
 * transaction committed and AFTER the settlement credit landed. A transient
 * PnL failure therefore rejects the close even though the position is closed
 * and the user was paid — and the PnL entry is lost for good, because a
 * retry fails with "Position not found or already closed".
 *
 * Expected after fix: closePosition resolves, the credit stays applied, and
 * the position stays closed.
 */
describe('close recordPnL failure must not report a committed close as failed', () => {
  it('closePosition resolves when recordPnL throws after the credit', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const service = buildService(db, wallet);

    const opened = await openLong(service);
    // margin 10 + fee 0.1 debited
    expect(wallet.peekBalance('u1')).toBeCloseTo(9989.9, 4);

    wallet.failRecordPnL = true;
    const closed = await service.closePosition({
      userId: 'u1',
      positionId: opened.positionId,
    });

    expect(closed.positionId).toBe(opened.positionId);
    // net settlement credited despite PnL failure: opening cost back out,
    // closing leg (margin + realized PnL - fee) back in.
    const expectedBalance =
      10_000 -
      (opened.marginPaid! + opened.feePaid) +
      ((closed.marginPaid ?? 0) + closed.realizedPnL! - closed.feePaid);
    expect(wallet.peekBalance('u1')).toBeCloseTo(expectedBalance, 4);
    const pos = await db.getPositionById(opened.positionId);
    expect(pos?.closedAt).not.toBeNull();
  });
});

/**
 * REPRO (candidate 2a): closePosition awaits wallet.getBalance AFTER the
 * close transaction committed and the settlement credit landed. A transient
 * balance-read failure rejects the close even though everything settled.
 * Same for addToPosition / flip, where the failure is worse: a caller that
 * reports failure invites a retry, and retrying an add/flip re-applies it —
 * debiting margin a second time and growing (or re-flipping) the position.
 *
 * Expected after fix: the trade resolves with balance omitted when the
 * post-commit balance read fails.
 */
describe('post-commit balance-read failure must not report a committed trade as failed', () => {
  it('closePosition resolves when getBalance throws after the credit', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const service = buildService(db, wallet);

    const opened = await openLong(service);
    wallet.failGetBalance = true;
    const closed = await service.closePosition({
      userId: 'u1',
      positionId: opened.positionId,
    });

    expect(closed.positionId).toBe(opened.positionId);
    expect(closed.balance).toBeUndefined();
    const expectedBalance =
      10_000 -
      (opened.marginPaid! + opened.feePaid) +
      ((closed.marginPaid ?? 0) + closed.realizedPnL! - closed.feePaid);
    expect(wallet.peekBalance('u1')).toBeCloseTo(expectedBalance, 4);
    const pos = await db.getPositionById(opened.positionId);
    expect(pos?.closedAt).not.toBeNull();
  });

  it('addToPosition resolves when getBalance throws after the add commits', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const service = buildService(db, wallet);

    const opened = await openLong(service, 100);
    wallet.failGetBalance = true;
    const added = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'long',
      size: 50,
      leverage: 10,
    });

    expect(added.positionId).toBe(opened.positionId);
    expect(added.balance).toBeUndefined();
    // Added exactly once: size 150, margin debited once for the add.
    const pos = await db.getPositionById(opened.positionId);
    expect(pos?.size).toBeCloseTo(150, 4);
    expect(wallet.peekBalance('u1')).toBeCloseTo(9984.85, 4);
  });

  it('flip resolves when getBalance throws after the flip commits', async () => {
    const db = new ReproDb([baseMarket]);
    const wallet = new ReproWallet(10_000);
    const service = buildService(db, wallet);

    await openLong(service, 100);
    wallet.failGetBalance = true;
    const flipped = await service.openPosition({
      userId: 'u1',
      ticker: 'ABC',
      side: 'short',
      size: 150,
      leverage: 10,
    });

    expect(flipped.side).toBe('short');
    expect(flipped.size).toBeCloseTo(50, 4);
    expect(flipped.balance).toBeUndefined();
    const pos = await db.getPositionById(flipped.positionId);
    expect(pos?.side).toBe('short');
    expect(pos?.size).toBeCloseTo(50, 4);
  });
});
