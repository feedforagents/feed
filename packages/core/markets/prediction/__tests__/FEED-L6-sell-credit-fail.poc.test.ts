/**
 * Regression: sell restores shares when proceeds credit is known not to have
 * landed. The restore applies inverse deltas so a concurrent trade is kept.
 * A credit that was applied and then threw (lost response) is not reversed.
 */
import { describe, expect, it } from 'bun:test';
import { WalletCreditNotAppliedError } from '@feed/shared';
import type { BroadcastPort, CachePort, WalletPort } from '../../shared/common';
import { PredictionMarketService } from '../PredictionMarketService';
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionPriceSnapshotRecord,
  PredictionSide,
} from '../types';

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

class FlakyCreditWallet implements WalletPort {
  balances = new Map<string, number>();
  creditCalls = 0;
  mode: 'fail-not-applied' | 'lose-response' | 'fail-unknown' | 'ok' =
    'fail-not-applied';
  appliedKeys = new Set<string>();
  lastRelatedId: string | undefined;
  lastIdempotencyKey: string | undefined;
  onCredit: (() => Promise<void>) | null = null;
  constructor(private defaultBalance = 10_000) {}
  async debit({ userId, amount }: { userId: string; amount: number }) {
    const b = this.balances.get(userId) ?? this.defaultBalance;
    if (b < amount) throw new Error('Insufficient funds');
    this.balances.set(userId, b - amount);
  }
  async credit(params: {
    userId: string;
    amount: number;
    relatedId?: string;
    idempotencyKey?: string;
  }) {
    this.creditCalls++;
    this.lastRelatedId = params.relatedId;
    this.lastIdempotencyKey = params.idempotencyKey;
    if (this.onCredit) await this.onCredit();
    if (this.mode === 'fail-not-applied') {
      throw new WalletCreditNotAppliedError('wallet credit failed');
    }
    if (this.mode === 'fail-unknown') {
      throw new Error('wallet credit outcome unknown');
    }
    if (params.idempotencyKey && this.appliedKeys.has(params.idempotencyKey)) {
      return;
    }
    const b = this.balances.get(params.userId) ?? this.defaultBalance;
    this.balances.set(params.userId, b + params.amount);
    if (params.idempotencyKey) this.appliedKeys.add(params.idempotencyKey);
    if (this.mode === 'lose-response') {
      throw new Error('credit response lost');
    }
  }
  async creditWasApplied(params: { idempotencyKey: string }) {
    return this.appliedKeys.has(params.idempotencyKey);
  }
  async recordPnL(): Promise<void> {}
  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class InMemoryDb implements PredictionDbPort {
  markets = new Map<string, PredictionMarketRecord>();
  positions = new Map<string, PredictionPositionRecord>();
  snapshots: PredictionPriceSnapshotRecord[] = [];
  idCounter = 1;
  constructor(initialMarket?: PredictionMarketRecord) {
    if (initialMarket) this.markets.set(initialMarket.id, { ...initialMarket });
  }
  async getMarketById(id: string) {
    const m = this.markets.get(id);
    return m ? { ...m } : null;
  }
  async getMarketsByIds(ids: string[]) {
    return ids
      .map((id) => this.markets.get(id))
      .filter((m): m is PredictionMarketRecord => !!m)
      .map((m) => ({ ...m }));
  }
  async listMarkets() {
    return Array.from(this.markets.values()).map((m) => ({ ...m }));
  }
  async countUnresolvedMarkets() {
    return Array.from(this.markets.values()).filter((m) => !m.resolved).length;
  }
  async listUserPositions(userId: string) {
    return Array.from(this.positions.values())
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p }));
  }
  async createMarketFromQuestion(): Promise<PredictionMarketRecord> {
    throw new Error('not used');
  }
  async updateMarketState(
    marketId: string,
    updates: Partial<PredictionMarketRecord>
  ) {
    const m = this.markets.get(marketId);
    if (!m) throw new Error('market not found');
    const updated = { ...m, ...updates };
    this.markets.set(marketId, updated);
    return { ...updated };
  }
  async applyMarketDelta(
    marketId: string,
    delta: { yesShares: number; noShares: number; liquidity: number }
  ) {
    const m = this.markets.get(marketId);
    if (!m) throw new Error('market not found');
    const updated = {
      ...m,
      yesShares: m.yesShares + delta.yesShares,
      noShares: m.noShares + delta.noShares,
      liquidity: m.liquidity + delta.liquidity,
    };
    this.markets.set(marketId, updated);
    return { ...updated };
  }
  async applyPositionShareDelta(
    positionId: string,
    deltaShares: number,
    minShares: number
  ) {
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    const shares = pos.shares + deltaShares;
    const terminal =
      pos.status === 'resolved' ||
      pos.status === 'cancelled' ||
      pos.status === 'voided';
    const status = terminal
      ? pos.status
      : shares > minShares
        ? 'active'
        : pos.status;
    const record = { ...pos, shares, status, updatedAt: new Date() };
    this.positions.set(positionId, record);
    return { ...record };
  }
  async getPosition(userId: string, marketId: string, side: PredictionSide) {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.marketId === marketId && p.side === side
    );
    return pos ? { ...pos } : null;
  }
  async upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ) {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record: PredictionPositionRecord = {
      id,
      userId: position.userId,
      marketId: position.marketId,
      side: position.side,
      shares: position.shares,
      avgPrice: position.avgPrice,
      status: position.status ?? 'active',
      outcome: position.outcome ?? null,
      pnl: position.pnl,
      resolvedAt: position.resolvedAt ?? null,
      createdAt: position.createdAt ?? new Date(),
      updatedAt: position.updatedAt ?? new Date(),
    };
    this.positions.set(id, record);
    return { ...record };
  }
  async deletePosition(positionId: string) {
    this.positions.delete(positionId);
  }
  async listPositionsForMarket(marketId: string) {
    return Array.from(this.positions.values())
      .filter((p) => p.marketId === marketId)
      .map((p) => ({ ...p }));
  }
  async insertPriceSnapshot(snapshot: PredictionPriceSnapshotRecord) {
    this.snapshots.push({ ...snapshot });
  }
}

class NoopBroadcast implements BroadcastPort {
  async emit(): Promise<void> {}
}
class NoopCache implements CachePort {
  async invalidate(): Promise<void> {}
}

describe('FEED-L6 sell credit-fail compensation', () => {
  it('restores shares when credit is known not to have landed', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('u1', 0);
    wallet.mode = 'fail-not-applied';
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new NoopBroadcast(),
      cache: new NoopCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor: {
        processTradingFee: async () => ({ feeCharged: 0, referrerPaid: 0 }),
      },
    });

    const beforeShares = (await db.getPosition('u1', 'm1', 'yes'))?.shares;
    await expect(
      service.sell({
        marketId: 'm1',
        userId: 'u1',
        shares: 100,
        positionId: pos.id,
      })
    ).rejects.toThrow('wallet credit failed');

    const afterPos = await db.getPosition('u1', 'm1', 'yes');
    // Compensating restore keeps shares intact when credit fails
    expect(afterPos?.shares).toBe(beforeShares);
    expect(afterPos?.status).toBe('active');
    expect((await wallet.getBalance('u1')).balance).toBe(0);
    expect(wallet.lastRelatedId).toBe('m1');
    expect(wallet.lastIdempotencyKey).toBeTruthy();

    wallet.mode = 'ok';
    await service.sell({
      marketId: 'm1',
      userId: 'u1',
      shares: 100,
      positionId: pos.id,
    });
    const sold = await db.getPosition('u1', 'm1', 'yes');
    expect(sold?.shares).toBe(0);
    expect(sold?.status).toBe('closed');
    expect((await wallet.getBalance('u1')).balance).toBeGreaterThan(0);
  });

  it('keeps a concurrent trade when credit is known not to have landed', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const before = await db.getMarketById('m1');
    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('u1', 0);
    wallet.mode = 'fail-not-applied';
    wallet.onCredit = async () => {
      await db.applyMarketDelta('m1', {
        yesShares: 100,
        noShares: 0,
        liquidity: 25,
      });
      await db.applyPositionShareDelta(pos.id, -15, 0.01);
    };
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new NoopBroadcast(),
      cache: new NoopCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
    });

    await expect(
      service.sell({
        marketId: 'm1',
        userId: 'u1',
        shares: 40,
        positionId: pos.id,
      })
    ).rejects.toThrow('wallet credit failed');

    const after = await db.getMarketById('m1');
    expect(after?.yesShares).toBeCloseTo((before?.yesShares ?? 0) + 100, 6);
    expect(after?.noShares).toBeCloseTo(before?.noShares ?? 0, 6);
    expect(after?.liquidity).toBeCloseTo((before?.liquidity ?? 0) + 25, 6);
    const afterPos = await db.getPosition('u1', 'm1', 'yes');
    // 100 sold down by 40, concurrent sell of 15, then +40 restored.
    expect(afterPos?.shares).toBeCloseTo(85, 6);
    expect(afterPos?.status).toBe('active');
    expect((await wallet.getBalance('u1')).balance).toBe(0);
  });

  it('keeps the sale when credit landed and the response was lost', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('u1', 0);
    wallet.mode = 'lose-response';
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new NoopBroadcast(),
      cache: new NoopCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
    });

    const result = await service.sell({
      marketId: 'm1',
      userId: 'u1',
      shares: 40,
      positionId: pos.id,
    });
    expect(result.shares).toBe(40);
    expect(wallet.creditCalls).toBe(1);
    const afterPos = await db.getPosition('u1', 'm1', 'yes');
    expect(afterPos?.shares).toBeCloseTo(60, 6);
    expect(afterPos?.status).toBe('active');
    const balance = (await wallet.getBalance('u1')).balance;
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeCloseTo(result.netProceeds ?? 0, 6);
  });

  it('does not restore shares when the credit outcome is unknown', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('u1', 0);
    wallet.mode = 'fail-unknown';
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new NoopBroadcast(),
      cache: new NoopCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
    });

    await expect(
      service.sell({
        marketId: 'm1',
        userId: 'u1',
        shares: 40,
        positionId: pos.id,
      })
    ).rejects.toThrow('wallet credit outcome unknown');

    const afterPos = await db.getPosition('u1', 'm1', 'yes');
    expect(afterPos?.shares).toBeCloseTo(60, 6);
    expect((await wallet.getBalance('u1')).balance).toBe(0);
  });

  it('falls back to a read-modify-write inverse when the db has no delta helpers', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    // Own properties shadow the prototype helpers so sell uses the fallback.
    Object.defineProperty(db, 'applyMarketDelta', { value: undefined });
    Object.defineProperty(db, 'applyPositionShareDelta', { value: undefined });
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const before = await db.getMarketById('m1');
    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('u1', 0);
    wallet.mode = 'fail-not-applied';
    wallet.onCredit = async () => {
      const current = await db.getMarketById('m1');
      if (!current) throw new Error('market missing');
      await db.updateMarketState('m1', {
        yesShares: current.yesShares + 100,
        liquidity: current.liquidity + 25,
      });
      const held = await db.getPosition('u1', 'm1', 'yes');
      if (!held) throw new Error('position missing');
      await db.upsertPosition({ ...held, shares: held.shares - 15 });
    };
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new NoopBroadcast(),
      cache: new NoopCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
    });

    await expect(
      service.sell({
        marketId: 'm1',
        userId: 'u1',
        shares: 40,
        positionId: pos.id,
      })
    ).rejects.toThrow('wallet credit failed');

    const after = await db.getMarketById('m1');
    expect(after?.yesShares).toBeCloseTo((before?.yesShares ?? 0) + 100, 6);
    expect(after?.liquidity).toBeCloseTo((before?.liquidity ?? 0) + 25, 6);
    const afterPos = await db.getPosition('u1', 'm1', 'yes');
    expect(afterPos?.shares).toBeCloseTo(85, 6);
    expect(afterPos?.status).toBe('active');
  });
});
