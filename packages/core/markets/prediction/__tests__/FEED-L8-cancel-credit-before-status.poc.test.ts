/**
 * FEED-L8 regression: PredictionMarketService.cancel must claim/mark the
 * position cancelled BEFORE wallet.credit(pred_cancel), and must restore
 * active only if that credit fails. A recordPnL failure after a successful
 * credit must not restore the position. Already-cancelled markets still
 * refund positions left active. Buy and sell are rejected once cancel has
 * marked the market, including during the refund loop.
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
  failRecordPnL = false;
  /** Throw on the credit attempt after this many successful credits. */
  failAfterSuccesses = Number.POSITIVE_INFINITY;
  onCredit: (() => Promise<void>) | null = null;
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
    if (this.failCredit || this.creditCalls >= this.failAfterSuccesses) {
      throw new Error('wallet credit failed');
    }
    if (this.onCredit) await this.onCredit();
    this.creditCalls++;
    this.credits.push({ userId, amount, reason });
    const b = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, b + amount);
  }
  async recordPnL(): Promise<void> {
    if (this.failRecordPnL) throw new Error('recordPnL failed');
  }
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
    // No refund landed, so the cancelling mark is cleared and the market
    // stays open for a retry.
    const m = await db.getMarketById('m1');
    expect(m?.resolved).toBe(false);
    expect(m?.resolution ?? null).toBeNull();
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
    const closed = await db.getMarketById('m1');
    expect(closed?.resolved).toBe(true);
    expect(closed?.resolution ?? null).toBeNull();
  });

  it('keeps the position cancelled when recordPnL fails after credit', async () => {
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
    wallet.failRecordPnL = true;
    const service = makeService(db, wallet);

    const result = await service.cancel({
      marketId: 'm1',
      reason: 'PoC cancel',
    });
    expect(result.positionsRefunded).toBe(1);
    expect(result.totalRefunded).toBe(50);
    expect((await wallet.getBalance('u1')).balance).toBe(50);
    expect((await db.getPosition('u1', 'm1', 'yes'))?.status).toBe('cancelled');
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);

    const again = await service.cancel({ marketId: 'm1', reason: 'retry' });
    expect(again.positionsRefunded).toBe(0);
    expect(again.totalRefunded).toBe(0);
    expect(wallet.creditCalls).toBe(1);
    expect((await wallet.getBalance('u1')).balance).toBe(50);
    await expect(
      service.sell({ marketId: 'm1', userId: 'u1', shares: 100 })
    ).rejects.toThrow(/cancelled/);
    expect(wallet.credits.filter((c) => c.reason === 'pred_sell')).toHaveLength(
      0
    );
  });

  it('refunds an active position left on an already-cancelled market', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 6000,
      noShares: 4000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: true,
      resolution: null,
      resolutionDescription: 'cancelled earlier',
    };
    const db = new MemoryDb(market);
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 80,
      avgPrice: 0.25,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.upsertPosition({
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      shares: 10,
      avgPrice: 0.4,
      status: 'cancelled',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new TrackingWallet(0);
    wallet.balances.set('u1', 0);
    wallet.balances.set('u2', 5);
    const service = makeService(db, wallet);

    const repaired = await service.cancel({
      marketId: 'm1',
      reason: 'repair',
    });
    expect(repaired.positionsRefunded).toBe(1);
    expect(repaired.totalRefunded).toBe(20);
    expect((await wallet.getBalance('u1')).balance).toBe(20);
    expect((await wallet.getBalance('u2')).balance).toBe(5);
    expect((await db.getPosition('u1', 'm1', 'yes'))?.status).toBe('cancelled');
    expect(wallet.credits.map((c) => c.reason)).toEqual(['pred_cancel']);

    await expect(
      service.buy({
        marketId: 'm1',
        userId: 'u1',
        side: 'yes',
        amount: 10,
      })
    ).rejects.toThrow(/resolved/);
    await expect(
      service.sell({ marketId: 'm1', userId: 'u1', shares: 80 })
    ).rejects.toThrow(/cancelled/);

    const second = await service.cancel({ marketId: 'm1' });
    expect(second.positionsRefunded).toBe(0);
    expect(wallet.creditCalls).toBe(1);
  });

  it('refunds only the unpaid position when a later credit fails', async () => {
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
    await db.upsertPosition({
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      shares: 40,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const wallet = new TrackingWallet(0);
    wallet.balances.set('u1', 0);
    wallet.balances.set('u2', 0);
    wallet.failAfterSuccesses = 1;
    const service = makeService(db, wallet);

    await expect(service.cancel({ marketId: 'm1' })).rejects.toThrow(
      'wallet credit failed'
    );
    expect((await db.getPosition('u1', 'm1', 'yes'))?.status).toBe('cancelled');
    expect((await db.getPosition('u2', 'm1', 'no'))?.status).toBe('active');
    expect((await wallet.getBalance('u1')).balance).toBe(50);
    expect((await wallet.getBalance('u2')).balance).toBe(0);
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);

    wallet.failAfterSuccesses = Number.POSITIVE_INFINITY;
    const repaired = await service.cancel({ marketId: 'm1' });
    expect(repaired.positionsRefunded).toBe(1);
    expect(repaired.totalRefunded).toBe(20);
    expect((await db.getPosition('u2', 'm1', 'no'))?.status).toBe('cancelled');
    expect((await wallet.getBalance('u1')).balance).toBe(50);
    expect((await wallet.getBalance('u2')).balance).toBe(20);
    expect(
      wallet.credits.filter((c) => c.reason === 'pred_cancel')
    ).toHaveLength(2);
  });

  it('rejects buy and sell while the refund loop is in progress', async () => {
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
    const wallet = new TrackingWallet(1_000);
    wallet.balances.set('u1', 1_000);
    const service = makeService(db, wallet);
    const seen: string[] = [];
    wallet.onCredit = async () => {
      try {
        await service.buy({
          marketId: 'm1',
          userId: 'u1',
          side: 'no',
          amount: 10,
        });
        seen.push('buy-allowed');
      } catch (error) {
        seen.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await service.sell({ marketId: 'm1', userId: 'u1', shares: 10 });
        seen.push('sell-allowed');
      } catch (error) {
        seen.push(error instanceof Error ? error.message : String(error));
      }
    };

    const result = await service.cancel({ marketId: 'm1', reason: 'race' });
    expect(result.positionsRefunded).toBe(1);
    expect(result.totalRefunded).toBe(50);
    expect(seen.some((line) => /resolved/i.test(line))).toBe(true);
    expect(seen.some((line) => /cancelled/i.test(line))).toBe(true);
    expect(seen.some((line) => line.endsWith('allowed'))).toBe(false);
    expect(wallet.credits.map((c) => c.reason)).toEqual(['pred_cancel']);
    const positions = await db.listPositionsForMarket('m1');
    expect(positions.filter((p) => p.status === 'active')).toHaveLength(0);
    expect((await wallet.getBalance('u1')).balance).toBe(1_050);
  });
});
