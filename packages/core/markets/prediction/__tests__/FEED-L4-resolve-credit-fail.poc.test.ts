/**
 * Regression: resolve defers resolved flag until credits succeed.
 * FEED-L4: PredictionMarketService.resolve marks market resolved, then credits
 * winners. If credit throws, retry no-ops (market.resolved) → permanent strand.
 * Distinct from #1577 (buy debit), #1556 (addToPosition), #1590 (openPosition).
 */
import { describe, expect, it } from 'bun:test';
import type {
  BroadcastPort,
  CachePort,
  WalletPort,
} from '../../shared/common';
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
  failNextCredit = true;
  constructor(private defaultBalance = 10_000) {}
  async debit({ userId, amount }: { userId: string; amount: number }) {
    const b = this.balances.get(userId) ?? this.defaultBalance;
    if (b < amount) throw new Error('Insufficient funds');
    this.balances.set(userId, b - amount);
  }
  async credit({ userId, amount }: { userId: string; amount: number }) {
    this.creditCalls++;
    if (this.failNextCredit) {
      this.failNextCredit = false;
      throw new Error('wallet credit failed');
    }
    const b = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, b + amount);
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

describe('FEED-L4 PoC resolve mark-then-credit permanent strand', () => {
  it('leaves winner unpaid after credit failure; retry no-ops', async () => {
    const market: PredictionMarketRecord = {
      id: 'm1',
      question: 'Will it rain?',
      yesShares: 5000,
      noShares: 5000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    };
    const db = new InMemoryDb(market);
    // Seed a YES winner position (cost basis 100)
    await db.upsertPosition({
      userId: 'winner',
      marketId: 'm1',
      side: 'yes',
      shares: 200,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Seed a NO loser so winners have a payout pool
    await db.upsertPosition({
      userId: 'loser',
      marketId: 'm1',
      side: 'no',
      shares: 200,
      avgPrice: 0.5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const wallet = new FlakyCreditWallet(0);
    wallet.balances.set('winner', 0);
    wallet.balances.set('loser', 0);
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

    await expect(
      service.resolve({ marketId: 'm1', winningSide: 'yes' })
    ).rejects.toThrow('wallet credit failed');

    const afterFail = await db.getMarketById('m1');
    // Market must stay unresolved so a retry can finish payouts
    expect(afterFail?.resolved).toBe(false);
    expect((await wallet.getBalance('winner')).balance).toBe(0);

    wallet.failNextCredit = false;
    await service.resolve({ marketId: 'm1', winningSide: 'yes' });
    expect((await wallet.getBalance('winner')).balance).toBeGreaterThan(0);
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);
    const pos = await db.getPosition('winner', 'm1', 'yes');
    expect(pos?.status).toBe('resolved');
  });
});
