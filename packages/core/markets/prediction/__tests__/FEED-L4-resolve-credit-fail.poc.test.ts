/**
 * Regression: resolve defers resolved flag until credits succeed.
 * FEED-L4: PredictionMarketService.resolve marks market resolved, then credits
 * winners. If credit throws, retry no-ops (market.resolved) → permanent strand.
 * Distinct from #1577 (buy debit), #1556 (addToPosition), #1590 (openPosition).
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

class FlakyCreditWallet implements WalletPort {
  balances = new Map<string, number>();
  creditCalls = 0;
  appliedCredits = 0;
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
    this.appliedCredits++;
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
    // Thrown credit did not apply, so the retry is the only payout.
    expect(wallet.creditCalls).toBe(2);
    expect(wallet.appliedCredits).toBe(1);
  });
});

class LedgerWallet implements WalletPort {
  balances = new Map<string, number>();
  credits: Array<{ userId: string; amount: number; description?: string }> = [];
  appliedKeys = new Set<string>();
  pnls: Array<{ userId: string; pnl: number }> = [];
  failNextRecordPnL = false;
  holdCredit: Promise<void> | null = null;
  creditEntered: (() => void) | null = null;

  async debit(): Promise<void> {}
  async credit(params: {
    userId: string;
    amount: number;
    reason: string;
    description?: string;
    relatedId?: string;
  }): Promise<void> {
    this.credits.push(params);
    const wait = this.holdCredit;
    if (this.creditEntered) {
      const entered = this.creditEntered;
      this.creditEntered = null;
      entered();
    }
    if (wait) await wait;
    // Same rule as WalletService: a repeated pred_resolve credit for the same
    // user, market, and description does not move the balance again.
    const key = `${params.userId}|${params.reason}|${params.relatedId ?? ''}|${params.description ?? ''}`;
    if (params.reason === 'pred_resolve' && this.appliedKeys.has(key)) return;
    this.appliedKeys.add(key);
    const balance = this.balances.get(params.userId) ?? 0;
    this.balances.set(params.userId, balance + params.amount);
  }
  async recordPnL(params: { userId: string; pnl: number }): Promise<void> {
    if (this.failNextRecordPnL) {
      this.failNextRecordPnL = false;
      throw new Error('recordPnL failed');
    }
    this.pnls.push(params);
  }
  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? 0 };
  }
}

class FlakyUpsertDb extends InMemoryDb {
  failResolvedUpsertOnce = false;
  override async upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ) {
    if (position.status === 'resolved' && this.failResolvedUpsertOnce) {
      this.failResolvedUpsertOnce = false;
      throw new Error('upsert resolved failed');
    }
    return super.upsertPosition(position);
  }
}

function seedContest(db: InMemoryDb) {
  const market: PredictionMarketRecord = {
    id: 'm1',
    question: 'Will it rain?',
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10_000,
    endDate: new Date(Date.now() + 3600_000),
    resolved: false,
  };
  db.markets.set(market.id, { ...market });
  return market;
}

function serviceFor(db: InMemoryDb, wallet: LedgerWallet) {
  return new PredictionMarketService({
    db,
    wallet,
    broadcast: new NoopBroadcast(),
    cache: new NoopCache(),
    clock: { now: () => new Date('2026-11-03T00:00:00.000Z') },
    fees: feeConfig,
    feeProcessor: {
      processTradingFee: async () => ({ feeCharged: 0, referrerPaid: 0 }),
    },
  });
}

async function seedWinnerAndLoser(db: InMemoryDb) {
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
}

describe('resolve does not double-pay', () => {
  it('credit then resolved-upsert failure pays the winner once on retry', async () => {
    const db = new FlakyUpsertDb();
    seedContest(db);
    await seedWinnerAndLoser(db);
    db.failResolvedUpsertOnce = true;
    const wallet = new LedgerWallet();
    const service = serviceFor(db, wallet);

    await expect(
      service.resolve({ marketId: 'm1', winningSide: 'yes' })
    ).rejects.toThrow('upsert resolved failed');
    expect((await db.getMarketById('m1'))?.resolved).toBe(false);
    const paidOnce = wallet.balances.get('winner') ?? 0;
    expect(paidOnce).toBeGreaterThan(0);
    expect(wallet.credits).toHaveLength(1);

    await service.resolve({ marketId: 'm1', winningSide: 'yes' });
    expect(wallet.balances.get('winner')).toBe(paidOnce);
    expect(wallet.credits).toHaveLength(1);
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);
    expect((await db.getPosition('winner', 'm1', 'yes'))?.status).toBe(
      'resolved'
    );
    expect(await db.getPosition('loser', 'm1', 'yes')).toBeNull();
    expect((await db.getPosition('loser', 'm1', 'no'))?.status).toBe(
      'resolved'
    );
  });

  it('recordPnL failure after credit does not pay the winner again on retry', async () => {
    const db = new InMemoryDb();
    seedContest(db);
    await seedWinnerAndLoser(db);
    const wallet = new LedgerWallet();
    wallet.failNextRecordPnL = true;
    const service = serviceFor(db, wallet);

    await expect(
      service.resolve({ marketId: 'm1', winningSide: 'yes' })
    ).rejects.toThrow('recordPnL failed');
    const paidOnce = wallet.balances.get('winner') ?? 0;
    expect(paidOnce).toBeGreaterThan(0);
    expect((await db.getPosition('winner', 'm1', 'yes'))?.status).toBe(
      'settling'
    );

    await service.resolve({ marketId: 'm1', winningSide: 'yes' });
    expect(wallet.balances.get('winner')).toBe(paidOnce);
    expect(wallet.credits.length).toBeGreaterThan(1);
    expect(wallet.appliedKeys.size).toBe(1);
    const winnerPnL = wallet.pnls.filter((entry) => entry.userId === 'winner');
    expect(winnerPnL).toHaveLength(1);
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);
  });

  it('overlapping resolve calls pay each winner once', async () => {
    const db = new InMemoryDb();
    seedContest(db);
    await seedWinnerAndLoser(db);
    const wallet = new LedgerWallet();
    let releaseCredit: () => void = () => {};
    wallet.holdCredit = new Promise<void>((resolve) => {
      releaseCredit = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      wallet.creditEntered = resolve;
    });
    const first = serviceFor(db, wallet);
    const second = serviceFor(db, wallet);

    const firstRun = first.resolve({ marketId: 'm1', winningSide: 'yes' });
    await entered;
    const secondRun = second.resolve({ marketId: 'm1', winningSide: 'yes' });
    releaseCredit();
    wallet.holdCredit = null;
    await Promise.all([firstRun, secondRun]);

    expect(wallet.credits).toHaveLength(1);
    expect(wallet.appliedKeys.size).toBe(1);
    expect((await db.getMarketById('m1'))?.resolved).toBe(true);
    expect((await db.getPosition('winner', 'm1', 'yes'))?.status).toBe(
      'resolved'
    );
  });

  it('a sell started during resolve cannot collect proceeds and a payout', async () => {
    const db = new InMemoryDb();
    seedContest(db);
    await seedWinnerAndLoser(db);
    const wallet = new LedgerWallet();
    let releaseCredit: () => void = () => {};
    wallet.holdCredit = new Promise<void>((resolve) => {
      releaseCredit = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      wallet.creditEntered = resolve;
    });
    const service = serviceFor(db, wallet);
    const winner = await db.getPosition('winner', 'm1', 'yes');

    const resolveRun = service.resolve({
      marketId: 'm1',
      winningSide: 'yes',
    });
    await entered;
    const sellRun = service.sell({
      userId: 'winner',
      marketId: 'm1',
      positionId: winner?.id,
      shares: 10,
    });
    releaseCredit();
    wallet.holdCredit = null;
    await resolveRun;
    await expect(sellRun).rejects.toThrow(/resolved/);

    expect(wallet.credits).toHaveLength(1);
    expect(wallet.credits[0]?.description ?? '').toContain('[pos-');
    expect((await db.getPosition('winner', 'm1', 'yes'))?.status).toBe(
      'resolved'
    );
  });
});
