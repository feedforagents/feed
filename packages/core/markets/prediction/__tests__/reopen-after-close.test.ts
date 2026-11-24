import { beforeEach, describe, expect, it } from 'bun:test';
import { PredictionMarketService } from '../PredictionMarketService';
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionPriceSnapshotRecord,
  PredictionSide,
} from '../types';

class InMemoryPredictionDb implements PredictionDbPort {
  markets = new Map<string, PredictionMarketRecord>();
  positions = new Map<string, PredictionPositionRecord>();
  private idCounter = 1;

  constructor(initialMarket: PredictionMarketRecord) {
    this.markets.set(initialMarket.id, { ...initialMarket });
  }

  async getMarketById(id: string): Promise<PredictionMarketRecord | null> {
    const m = this.markets.get(id);
    return m ? { ...m } : null;
  }

  async getMarketsByIds(ids: string[]): Promise<PredictionMarketRecord[]> {
    return ids
      .map((id) => this.markets.get(id))
      .filter((m): m is PredictionMarketRecord => Boolean(m))
      .map((m) => ({ ...m }));
  }

  async listMarkets(): Promise<PredictionMarketRecord[]> {
    return Array.from(this.markets.values()).map((m) => ({ ...m }));
  }

  async countUnresolvedMarkets(): Promise<number> {
    return Array.from(this.markets.values()).filter((m) => !m.resolved).length;
  }

  async listUserPositions(userId: string): Promise<PredictionPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter(
        (p) => p.userId === userId && (!p.status || p.status === 'active')
      )
      .map((p) => ({ ...p }));
  }

  async getQuestion(): Promise<null> {
    return null;
  }

  async createMarketFromQuestion(): Promise<PredictionMarketRecord> {
    throw new Error('not used in tests');
  }

  async updateMarketState(
    marketId: string,
    updates: Partial<PredictionMarketRecord>
  ): Promise<PredictionMarketRecord> {
    const m = this.markets.get(marketId);
    if (!m) throw new Error('market not found');
    const updated = { ...m, ...updates };
    this.markets.set(marketId, updated);
    return { ...updated };
  }

  // Mirror PredictionDbAdapter.getPosition: prefer active rows over closed/settled rows,
  // then most recently updated / created.
  async getPosition(
    userId: string,
    marketId: string,
    side: PredictionSide
  ): Promise<PredictionPositionRecord | null> {
    const matching = Array.from(this.positions.values()).filter(
      (p) => p.userId === userId && p.marketId === marketId && p.side === side
    );
    if (matching.length === 0) return null;
    matching.sort((a, b) => {
      const aActive = !a.status || a.status === 'active' ? 1 : 0;
      const bActive = !b.status || b.status === 'active' ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      const updatedDiff =
        (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
      if (updatedDiff !== 0) return updatedDiff;
      return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
    });
    return { ...matching[0]! };
  }

  async upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ): Promise<PredictionPositionRecord> {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record: PredictionPositionRecord = {
      id,
      userId: position.userId,
      marketId: position.marketId,
      side: position.side,
      shares: Number(position.shares.toFixed(6)),
      avgPrice: position.avgPrice,
      cashCostBasis: position.cashCostBasis,
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

  async deletePosition(positionId: string): Promise<void> {
    this.positions.delete(positionId);
  }

  async listPositionsForMarket(
    marketId: string
  ): Promise<PredictionPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => p.marketId === marketId)
      .map((p) => ({ ...p }));
  }

  async insertPriceSnapshot(
    _snapshot: PredictionPriceSnapshotRecord
  ): Promise<void> {}
}

class InMemoryWallet {
  balances = new Map<string, number>();

  constructor(initial: Record<string, number>) {
    for (const [userId, balance] of Object.entries(initial)) {
      this.balances.set(userId, balance);
    }
  }

  async debit(params: { userId: string; amount: number }) {
    const current = this.balances.get(params.userId) ?? 0;
    if (current < params.amount) throw new Error('insufficient balance');
    this.balances.set(params.userId, current - params.amount);
  }

  async credit(params: { userId: string; amount: number }) {
    const current = this.balances.get(params.userId) ?? 0;
    this.balances.set(params.userId, current + params.amount);
  }

  async recordPnL() {}

  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? 0 };
  }
}

describe('PredictionMarketService re-entry after closed position', () => {
  let db: InMemoryPredictionDb;
  let wallet: InMemoryWallet;
  let service: PredictionMarketService;
  let tick: number;

  beforeEach(() => {
    tick = 1_700_000_000_000;
    db = new InMemoryPredictionDb({
      id: 'm1',
      question: 'Will re-entry preserve closed position history?',
      yesShares: 5_000,
      noShares: 5_000,
      liquidity: 10_000,
      resolved: false,
      resolution: null,
      endDate: new Date(Date.now() + 86_400_000),
    });
    wallet = new InMemoryWallet({ u1: 10_000, u2: 10_000 });
    service = new PredictionMarketService({
      db,
      wallet,
      fees: {
        tradingFeeRate: 0.001,
        platformShare: 0.5,
        referrerShare: 0.5,
        minFeeAmount: 0.01,
      },
      clock: {
        now: () => {
          tick += 1_000;
          return new Date(tick);
        },
      },
    });
  });

  it('opens a new active row after a full sell and keeps the closed row and its realized PnL intact through resolution', async () => {
    const buy1 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });
    // Second trader moves YES higher so u1 closes trade #1 at a realized gain.
    await service.buy({
      userId: 'u2',
      marketId: 'm1',
      side: 'yes',
      amount: 1_500,
    });

    const sell1 = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: buy1.shares,
    });
    expect(sell1.positionClosed).toBe(true);
    expect(sell1.pnl).toBeGreaterThan(0);

    const closedBeforeRebuy = db.positions.get(buy1.positionId);
    expect(closedBeforeRebuy?.status).toBe('closed');
    expect(closedBeforeRebuy?.shares).toBe(0);
    expect(closedBeforeRebuy?.cashCostBasis).toBe(0);
    expect(closedBeforeRebuy?.pnl).toBe(sell1.pnl);

    // Re-enter YES on the same still-open market.
    const buy2 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 50,
    });
    expect(buy2.positionId).not.toBe(buy1.positionId);

    // Original closed row must remain untouched for Closed Positions history.
    const closedAfterRebuy = db.positions.get(buy1.positionId);
    expect(closedAfterRebuy?.status).toBe('closed');
    expect(closedAfterRebuy?.shares).toBe(0);
    expect(closedAfterRebuy?.cashCostBasis).toBe(0);
    expect(closedAfterRebuy?.pnl).toBe(sell1.pnl);

    const activeRow = db.positions.get(buy2.positionId);
    expect(activeRow?.status).toBe('active');
    expect(activeRow?.pnl).toBe(0);
    expect(activeRow?.cashCostBasis).toBe(50);
    expect(activeRow?.shares).toBeCloseTo(buy2.shares, 6);
    expect(activeRow?.outcome).toBeNull();
    expect(activeRow?.resolvedAt).toBeNull();

    // Adding to the new active position must still merge into the active row.
    const buy3 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 25,
    });
    expect(buy3.positionId).toBe(buy2.positionId);
    const mergedActive = db.positions.get(buy2.positionId);
    expect(mergedActive?.cashCostBasis).toBe(75);
    expect(mergedActive?.shares).toBeCloseTo(buy2.shares + buy3.shares, 6);

    // Resolving as a loss must settle only the active row without blending closed trade #1's gain.
    await service.resolve({ marketId: 'm1', winningSide: 'no' });

    const closedAfterResolve = db.positions.get(buy1.positionId);
    expect(closedAfterResolve?.status).toBe('closed');
    expect(closedAfterResolve?.pnl).toBe(sell1.pnl);

    const resolvedActive = db.positions.get(buy2.positionId);
    expect(resolvedActive?.status).toBe('resolved');
    expect(resolvedActive?.outcome).toBe(false);
    expect(resolvedActive?.pnl).toBe(-75);
  });

  it('does not leak prior closed-trade PnL onto a re-entered position when the market is cancelled', async () => {
    const buy1 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });
    await service.buy({
      userId: 'u2',
      marketId: 'm1',
      side: 'yes',
      amount: 1_500,
    });
    const sell1 = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: buy1.shares,
    });
    expect(sell1.positionClosed).toBe(true);
    expect(sell1.pnl).toBeGreaterThan(0);

    const buy2 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 50,
    });
    expect(buy2.positionId).not.toBe(buy1.positionId);

    const balanceBeforeCancel = (await wallet.getBalance('u1')).balance;
    await service.cancel({ marketId: 'm1', reason: 'voided' });
    const balanceAfterCancel = (await wallet.getBalance('u1')).balance;
    expect(balanceAfterCancel - balanceBeforeCancel).toBe(50);

    expect(db.positions.get(buy1.positionId)?.status).toBe('closed');
    expect(db.positions.get(buy1.positionId)?.pnl).toBe(sell1.pnl);

    const cancelledActive = db.positions.get(buy2.positionId);
    expect(cancelledActive?.status).toBe('cancelled');
    expect(cancelledActive?.outcome).toBeNull();
    expect(cancelledActive?.pnl).toBe(0);
  });

  it('ignores non-active rows with stale shares/fields and still merges into legacy active rows with omitted status', async () => {
    const staleDate = new Date('2026-01-01T00:00:00.000Z');
    db.positions.set('legacy-cancelled', {
      id: 'legacy-cancelled',
      userId: 'u1',
      marketId: 'm1',
      side: 'no',
      shares: 10,
      avgPrice: 0.4,
      cashCostBasis: 4,
      status: 'cancelled',
      outcome: true,
      pnl: 42,
      resolvedAt: staleDate,
      createdAt: staleDate,
      updatedAt: staleDate,
    });

    const freshBuy = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'no',
      amount: 20,
    });
    expect(freshBuy.positionId).not.toBe('legacy-cancelled');
    const freshRow = db.positions.get(freshBuy.positionId);
    expect(freshRow?.status).toBe('active');
    expect(freshRow?.pnl).toBe(0);
    expect(freshRow?.outcome).toBeNull();
    expect(freshRow?.resolvedAt).toBeNull();
    expect(freshRow?.cashCostBasis).toBe(20);
    expect(freshBuy.shares).toBeCloseTo(freshRow!.shares, 6);

    // Legacy active row with omitted status must still merge on add-on buy.
    db.positions.set('legacy-active-no-status', {
      id: 'legacy-active-no-status',
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      shares: 10,
      avgPrice: 0.5,
      cashCostBasis: 5,
      status: undefined,
      outcome: null,
      pnl: 0,
      resolvedAt: null,
      createdAt: staleDate,
      updatedAt: staleDate,
    });

    const addBuy = await service.buy({
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      amount: 10,
    });
    expect(addBuy.positionId).toBe('legacy-active-no-status');
    const updatedLegacy = db.positions.get('legacy-active-no-status');
    expect(updatedLegacy?.status).toBe('active');
    expect(updatedLegacy?.cashCostBasis).toBe(15);
    expect(updatedLegacy?.shares).toBeCloseTo(10 + addBuy.shares, 6);
  });
});
