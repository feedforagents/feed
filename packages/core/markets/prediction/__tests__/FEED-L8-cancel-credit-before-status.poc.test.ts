/**
 * FEED-L8 regression: PredictionMarketService.cancel must claim/mark the
 * position cancelled BEFORE wallet.credit(pred_cancel), and must restore
 * active if credit fails. Credit-before-status + sell-allowed-on-cancelled
 * market minted free money (refund + sell proceeds).
 *
 * Distinct from:
 *   #1580 (cancel fee gross-up arithmetic)
 *   #1559 (concurrent sell↔resolve claim; cancel out of scope there)
 *   #1594 (resolve mark-before-credit strand)
 *   #1595 (sell mutate-then-credit strand)
 *
 * PRD §9.1 / §9.2, MVP Phase 6.
 */
import { describe, expect, it } from 'bun:test';
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

class TrackingWallet implements WalletPort {
  balances = new Map<string, number>();
  creditCalls = 0;
  credits: Array<{ userId: string; amount: number; reason: string }> = [];
  failCredit = false;
  constructor(private defaultBalance = 10_000) {}
  async debit({ userId, amount }: { userId: string; amount: number }) {
    const b = this.balances.get(userId) ?? this.defaultBalance;
    if (b < amount) throw new Error('Insufficient funds');
    this.balances.set(userId, b - amount);
  }
  async credit({
    userId,
    amount,
    reason,
  }: {
    userId: string;
    amount: number;
    reason: string;
  }) {
    if (this.failCredit) {
      throw new Error('wallet credit failed');
    }
    this.creditCalls++;
    this.credits.push({ userId, amount, reason });
    const b = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, b + amount);
  }
  async recordPnL(): Promise<void> {}
  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class MemoryDb implements PredictionDbPort {
  markets = new Map<string, PredictionMarketRecord>();
  positions = new Map<string, PredictionPositionRecord>();
  snapshots: PredictionPriceSnapshotRecord[] = [];
  idCounter = 1;
  failOnCancelledMark = false;
  cancelledMarkAttempts = 0;

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
  async getPosition(userId: string, marketId: string, side: PredictionSide) {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.marketId === marketId && p.side === side
    );
    return pos ? { ...pos } : null;
  }
  async upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ) {
    if (this.failOnCancelledMark && position.status === 'cancelled') {
      this.cancelledMarkAttempts++;
      throw new Error('db upsert cancelled-status failed');
    }
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

function makeService(db: MemoryDb, wallet: TrackingWallet) {
  return new PredictionMarketService({
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
}

describe('FEED-L8 cancel claim-before-credit', () => {
  it('does not credit when cancelled-status mark fails (no free-money window)', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new MemoryDb(market);
    db.failOnCancelledMark = true;
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new TrackingWallet(0);
    wallet.balances.set('u1', 0);
    const service = makeService(db, wallet);

    await expect(
      service.cancel({ marketId: 'm1', reason: 'PoC cancel' })
    ).rejects.toThrow('db upsert cancelled-status failed');

    // Mark runs before credit: failure means no refund landed.
    expect(wallet.creditCalls).toBe(0);
    expect((await wallet.getBalance('u1')).balance).toBe(0);
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.status).toBe('active');
    expect(db.cancelledMarkAttempts).toBe(1);
  });

  it('restores active and leaves balance unchanged when credit fails after mark', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new MemoryDb(market);
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new TrackingWallet(0);
    wallet.balances.set('u1', 0);
    wallet.failCredit = true;
    const service = makeService(db, wallet);

    await expect(
      service.cancel({ marketId: 'm1', reason: 'PoC cancel' })
    ).rejects.toThrow('wallet credit failed');

    expect(wallet.creditCalls).toBe(0);
    expect((await wallet.getBalance('u1')).balance).toBe(0);
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.status).toBe('active');
    // Market mark deferred until after refunds — still open / retryable.
    const m = await db.getMarketById('m1');
    expect(m?.resolved).toBe(false);
  });

  it('happy-path cancel refunds once and blocks subsequent sell', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new MemoryDb(market);
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
    const wallet = new TrackingWallet(0);
    wallet.balances.set('u1', 0);
    const service = makeService(db, wallet);

    const result = await service.cancel({
      marketId: 'm1',
      reason: 'PoC cancel',
    });
    expect(result.positionsRefunded).toBe(1);
    expect(result.totalRefunded).toBe(50);
    expect((await wallet.getBalance('u1')).balance).toBe(50);
    expect(wallet.credits.map((c) => c.reason)).toEqual(['pred_cancel']);

    const after = await db.getPosition('u1', 'm1', 'yes');
    expect(after?.status).toBe('cancelled');

    await expect(
      service.sell({
        marketId: 'm1',
        userId: 'u1',
        shares: 100,
        positionId: pos.id,
      })
    ).rejects.toThrow(/cancelled/);
    expect(wallet.creditCalls).toBe(1);
  });
});
