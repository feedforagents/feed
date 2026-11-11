import { beforeEach, describe, expect, it } from 'bun:test';
import { floorPoints } from '@feed/shared';
import type {
  BroadcastPort,
  CachePort,
  FeeProcessor,
  WalletPort,
} from '../../shared/common';
import { PredictionMarketService } from '../PredictionMarketService';
import { PredictionPricing } from '../pricing';
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

class InMemoryWallet implements WalletPort {
  balances = new Map<string, number>();
  pnls: Array<{ userId: string; pnl: number; reason: string }> = [];

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
    this.pnls.push({ userId, pnl, reason });
  }

  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class InMemoryDb implements PredictionDbPort {
  markets = new Map<string, PredictionMarketRecord>();
  positions = new Map<string, PredictionPositionRecord>();
  snapshots: PredictionPriceSnapshotRecord[] = [];
  idCounter = 1;

  constructor(initialMarket?: PredictionMarketRecord) {
    if (initialMarket) {
      this.markets.set(initialMarket.id, { ...initialMarket });
    }
  }

  async getMarketById(id: string): Promise<PredictionMarketRecord | null> {
    const m = this.markets.get(id);
    return m ? { ...m } : null;
  }

  async getMarketsByIds(ids: string[]): Promise<PredictionMarketRecord[]> {
    return ids
      .map((id) => this.markets.get(id))
      .filter((m): m is PredictionMarketRecord => !!m)
      .map((m) => ({ ...m }));
  }

  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PredictionMarketRecord[]> {
    const all = Array.from(this.markets.values())
      .filter((m) => !m.resolved)
      .sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
      )
      .map((m) => ({ ...m }));
    if (options?.limit == null) return all;
    const off = options.offset ?? 0;
    return all.slice(off, off + options.limit);
  }

  async countUnresolvedMarkets(): Promise<number> {
    return Array.from(this.markets.values()).filter((m) => !m.resolved).length;
  }

  async listUserPositions(userId: string): Promise<PredictionPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p }));
  }

  async createMarketFromQuestion(
    _question: unknown,
    _initialLiquidity: number,
    _options?: { description?: string | null }
  ): Promise<PredictionMarketRecord> {
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

  async getPosition(
    userId: string,
    marketId: string,
    side: PredictionSide
  ): Promise<PredictionPositionRecord | null> {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.marketId === marketId && p.side === side
    );
    return pos ? { ...pos } : null;
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
    snapshot: PredictionPriceSnapshotRecord
  ): Promise<void> {
    this.snapshots.push({ ...snapshot });
  }
}

class InMemoryBroadcast implements BroadcastPort {
  events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  async emit(channel: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ channel, payload });
  }
}

class InMemoryCache implements CachePort {
  keys: string[] = [];
  async invalidate(pattern: string): Promise<void> {
    this.keys.push(pattern);
  }
}

describe('PredictionMarketService', () => {
  const market: PredictionMarketRecord = {
    id: 'm1',
    question: 'Will it rain?',
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10_000,
    endDate: new Date(Date.now() + 3600_000),
    resolved: false,
  };

  let db: InMemoryDb;
  let wallet: InMemoryWallet;
  let broadcast: InMemoryBroadcast;
  let cache: InMemoryCache;
  let feeProcessor: FeeProcessor;
  let service: PredictionMarketService;

  beforeEach(() => {
    db = new InMemoryDb(market);
    wallet = new InMemoryWallet();
    broadcast = new InMemoryBroadcast();
    cache = new InMemoryCache();
    feeProcessor = {
      processTradingFee: async () => ({ feeCharged: 0, referrerPaid: 0 }),
    };
    service = new PredictionMarketService({
      db,
      wallet,
      broadcast,
      cache,
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
    });
  });

  it('buy should increase shares, position, liquidity and emit snapshot/event', async () => {
    const result = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });

    expect(result.shares).toBeGreaterThan(0);
    expect(result.market.liquidity).toBeGreaterThan(market.liquidity);
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.shares).toBeCloseTo(result.shares);
    expect(db.snapshots.length).toBe(1);
    expect(broadcast.events.length).toBe(1);
    expect(cache.keys).toContain('prediction:m1:*');
  });

  it('buy should allow overriding trade attribution', async () => {
    service = new PredictionMarketService({
      db,
      wallet,
      broadcast,
      cache,
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
      tradeSource: 'npc_trade',
      tradeActorType: 'npc',
    });

    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });

    expect(db.snapshots[0]?.source).toBe('npc_trade');

    const event = broadcast.events[0]?.payload as unknown as {
      type?: string;
      trade?: { actorType?: string; source?: string };
    };
    expect(event.type).toBe('prediction_trade');
    expect(event.trade?.actorType).toBe('npc');
    expect(event.trade?.source).toBe('npc_trade');
  });

  it('sell should decrease position, compute pnl, and close when remaining small', async () => {
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos).not.toBeNull();
    const sellShares = pos!.shares * 0.9;
    const result = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: sellShares,
    });
    expect(result.netProceeds).toBeGreaterThan(0);
    expect(result.positionClosed).toBe(false);

    const result2 = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: pos!.shares - sellShares,
    });
    expect(result2.positionClosed).toBe(true);
    const closed = await db.getPosition('u1', 'm1', 'yes');
    expect(closed).not.toBeNull();
    expect(closed?.status).toBe('closed');
    expect(closed?.shares).toBe(0);
  });

  it('should ignore closed positions when selecting a position to sell', async () => {
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 50,
    });
    await service.buy({ userId: 'u1', marketId: 'm1', side: 'no', amount: 50 });

    const yesPos = await db.getPosition('u1', 'm1', 'yes');
    const noPos = await db.getPosition('u1', 'm1', 'no');
    expect(yesPos).not.toBeNull();
    expect(noPos).not.toBeNull();

    await service.sell({
      userId: 'u1',
      marketId: 'm1',
      positionId: yesPos!.id,
      shares: yesPos!.shares,
    });

    const sellNo = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: noPos!.shares,
    });
    expect(sellNo.positionClosed).toBe(true);
  });

  it('should require positionId when both sides exist', async () => {
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 50,
    });
    await service.buy({ userId: 'u1', marketId: 'm1', side: 'no', amount: 50 });
    await expect(
      service.sell({ userId: 'u1', marketId: 'm1', shares: 1 })
    ).rejects.toThrow(/Specify positionId/);
  });

  it('should block buys on resolved markets', async () => {
    await db.updateMarketState('m1', { resolved: true });
    await expect(
      service.buy({ userId: 'u1', marketId: 'm1', side: 'yes', amount: 10 })
    ).rejects.toThrow(/resolved/);
  });

  it('should block buys on expired markets', async () => {
    await db.updateMarketState('m1', {
      resolved: false,
      endDate: new Date(Date.now() - 1000),
    });
    await expect(
      service.buy({ userId: 'u1', marketId: 'm1', side: 'yes', amount: 10 })
    ).rejects.toThrow(/expired/);
  });

  it('should allow sells on expired but unresolved markets', async () => {
    // First buy a position while market is active
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos).not.toBeNull();

    // Expire the market (but don't resolve it)
    await db.updateMarketState('m1', {
      endDate: new Date(Date.now() - 1000),
    });

    // User should still be able to close their position
    const result = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: pos!.shares,
    });
    expect(result.positionClosed).toBe(true);
    expect(result.netProceeds).toBeGreaterThan(0);
  });

  it('should reject a sell that moves odds beyond the per-trade limit', async () => {
    // A holder who accumulated gradually (each buy inside the 20ppt
    // guard) can dump the whole position in one sell. Buys are guarded
    // against single-trade odds swings; sells must be guarded the same
    // way, or one dump crashes the odds from 50% to ~17%.
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 9000,
      avgPrice: 0.5,
      cashCostBasis: 4500,
      status: 'active',
      outcome: null,
      pnl: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.sell({ userId: 'u1', marketId: 'm1', shares: 9000 })
    ).rejects.toThrow(/move odds/);

    // Rejected trade must leave market and position untouched.
    const after = await db.getMarketById('m1');
    expect(after?.yesShares).toBe(5000);
    expect(after?.noShares).toBe(5000);
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.shares).toBe(9000);
    expect(pos?.status).toBe('active');
  });

  it('should reject a sell that pushes YES odds below the hard floor', async () => {
    // Odds already near the floor (5%): a sell that shifts odds by less
    // than the 20ppt per-trade limit can still push them below 2%.
    const thinDb = new InMemoryDb({
      id: 'm2',
      question: 'Thin market?',
      yesShares: 9500,
      noShares: 500,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    });
    const thinService = new PredictionMarketService({
      db: thinDb,
      wallet,
      broadcast,
      cache,
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
    });
    await thinDb.upsertPosition({
      userId: 'u1',
      marketId: 'm2',
      side: 'yes',
      shares: 6000,
      avgPrice: 0.05,
      cashCostBasis: 300,
      status: 'active',
      outcome: null,
      pnl: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      thinService.sell({ userId: 'u1', marketId: 'm2', shares: 6000 })
    ).rejects.toThrow(/YES odds/);

    const after = await thinDb.getMarketById('m2');
    expect(after?.yesShares).toBe(9500);
    expect(after?.noShares).toBe(500);
  });

  it('should allow a sell that moves odds beyond the limit with maxOddsMove', async () => {
    // Parity with buy: agent/NPC callers can opt into a larger move.
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 9000,
      avgPrice: 0.5,
      cashCostBasis: 4500,
      status: 'active',
      outcome: null,
      pnl: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: 9000,
      maxOddsMove: 1,
    });
    expect(result.positionClosed).toBe(true);
    expect(result.market.yesPrice).toBeLessThan(0.2);
  });

  it('should block sells on resolved markets with outcome', async () => {
    // First buy a position
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });

    // Resolve the market with an outcome (YES wins)
    await db.updateMarketState('m1', { resolved: true, resolution: true });

    await expect(
      service.sell({ userId: 'u1', marketId: 'm1', shares: 1 })
    ).rejects.toThrow(/resolved/);
  });

  it('should allow sells on cancelled markets (resolved but no outcome)', async () => {
    // First buy a position
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });

    // Cancel the market (resolved but no outcome)
    await db.updateMarketState('m1', { resolved: true, resolution: null });

    // Should be able to sell on cancelled market
    const result = await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: 1,
    });
    expect(result.shares).toBe(1);
  });

  it('should block sells on cancelled positions (double-refund prevention)', async () => {
    // Security test: Ensure users cannot sell positions that have been refunded via cancel()
    // This prevents a double-payment exploit where user gets refund + sell proceeds

    // First buy a position
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });

    const balanceBeforeCancel = (await wallet.getBalance('u1')).balance;

    // Cancel the market - this refunds the position and marks it 'cancelled'
    const cancelResult = await service.cancel({
      marketId: 'm1',
      reason: 'Test cancel',
    });
    expect(cancelResult.positionsRefunded).toBe(1);
    expect(cancelResult.totalRefunded).toBeGreaterThan(0);

    const balanceAfterCancel = (await wallet.getBalance('u1')).balance;
    expect(balanceAfterCancel).toBeGreaterThan(balanceBeforeCancel);

    // Verify position is now cancelled
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.status).toBe('cancelled');

    // Attempt to sell the cancelled position should fail
    // This is the critical security check - without it, user could get double payment
    await expect(
      service.sell({ userId: 'u1', marketId: 'm1', shares: 1 })
    ).rejects.toThrow(/not found/);
  });

  it('cancel should refund the full cash paid, including the entry fee', async () => {
    const startBalance = (await wallet.getBalance('u1')).balance;

    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 1000,
    });
    expect((await wallet.getBalance('u1')).balance).toBe(startBalance - 1000);

    const cancelResult = await service.cancel({
      marketId: 'm1',
      reason: 'Test cancel',
    });

    // Full refund: the user is made whole, not refunded net of the 1 pt
    // entry fee (0.1% of 1000), and the cancellation records no PnL loss.
    expect(cancelResult.totalRefunded).toBe(1000);
    expect((await wallet.getBalance('u1')).balance).toBe(startBalance);
    expect(wallet.pnls.filter((p) => p.reason === 'pred_cancel')).toEqual([]);
    const pos = await db.getPosition('u1', 'm1', 'yes');
    expect(pos?.pnl).toBe(0);
  });

  it('cancel after a partial sell should refund the remaining gross cash basis', async () => {
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 1000,
    });
    const pos = await db.getPosition('u1', 'm1', 'yes');
    await service.sell({
      userId: 'u1',
      marketId: 'm1',
      shares: Math.floor((pos?.shares ?? 0) / 2),
    });

    const balanceBeforeCancel = (await wallet.getBalance('u1')).balance;
    const cancelResult = await service.cancel({
      marketId: 'm1',
      reason: 'Test cancel',
    });

    // Remaining gross cash basis after selling half the shares bought for
    // 1000 (fee included): 500.45, not the 499.94 net-of-fee shares*avgPrice.
    expect(cancelResult.totalRefunded).toBe(500.45);
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(
      balanceBeforeCancel + 500.45
    );
    expect(wallet.pnls.filter((p) => p.reason === 'pred_cancel')).toEqual([]);
  });

  it('cancel should refund legacy positions at their grossed-up cash basis', async () => {
    // Position row without a stored cashCostBasis (pre-migration shape):
    // 100 shares at avgPrice 0.5 were bought with 50.05 gross cash at the
    // 0.1% fee rate, so the refund is 50.05, not the 50 net amount.
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
    });

    const cancelResult = await service.cancel({
      marketId: 'm1',
      reason: 'Test cancel',
    });

    expect(cancelResult.totalRefunded).toBe(50.05);
    expect(wallet.pnls.filter((p) => p.reason === 'pred_cancel')).toEqual([]);
  });

  it('should prevent liquidity going negative on sell', async () => {
    // Force tiny liquidity but large reserves so proceeds exceed liquidity
    await db.updateMarketState('m1', { liquidity: 1 });
    const pos = await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 100,
      avgPrice: 0.5,
    });
    await expect(
      service.sell({ userId: 'u1', marketId: 'm1', shares: pos.shares })
    ).rejects.toThrow(/liquidity/);
  });

  it('resolve should payout winners and set positions resolved', async () => {
    await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 100,
    });
    await service.buy({
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      amount: 100,
    });

    const marketPreResolve = await service.getMarket('m1');
    expect(marketPreResolve).not.toBeNull();

    const preWinnerBalance = (await wallet.getBalance('u1')).balance;
    const preLoserBalance = (await wallet.getBalance('u2')).balance;
    await service.resolve({
      marketId: 'm1',
      winningSide: 'yes',
      resolutionDescription: 'It rained',
    });
    const pos1 = await db.getPosition('u1', 'm1', 'yes');
    const pos2 = await db.getPosition('u2', 'm1', 'no');
    expect(pos1?.status).toBe('resolved');
    expect(pos2?.status).toBe('resolved');
    expect(pos1?.outcome).toBe(true);
    expect(pos2?.outcome).toBe(false);
    const postWinnerBalance = (await wallet.getBalance('u1')).balance;
    const postLoserBalance = (await wallet.getBalance('u2')).balance;
    expect(postWinnerBalance).toBeGreaterThan(preWinnerBalance);
    expect(postLoserBalance).toBeLessThanOrEqual(preLoserBalance);

    // PRD §9.2 [D-14]: a winning share redeems for exactly 1 pt.
    // The payout is the share count, not cost basis plus a
    // pool-proportional share of the loser's deposits.
    const expectedWinnerPayout = floorPoints(pos1!.shares);
    const expectedWinnerPnl = expectedWinnerPayout - 100;
    const expectedLoserPnl = -100;

    expect(postWinnerBalance - preWinnerBalance).toBeCloseTo(
      expectedWinnerPayout
    );
    expect(pos1?.pnl).toBeCloseTo(expectedWinnerPnl);
    expect(pos1?.pnl).toBeGreaterThan(0);
    expect(pos2?.pnl).toBeCloseTo(expectedLoserPnl);

    // Liquidity should decrease by total payouts (capped at available liquidity)
    const marketAfterResolve = await service.getMarket('m1');
    expect(marketAfterResolve?.resolved).toBe(true);
    const payout = expectedWinnerPayout;
    const expectedReduction = Math.min(payout, marketPreResolve!.liquidity);
    expect(marketAfterResolve!.liquidity).toBeCloseTo(
      marketPreResolve!.liquidity - expectedReduction,
      6
    );

    // PnL should be recorded for both winner and loser (loser negative)
    const pnlByUser = new Map(wallet.pnls.map((p) => [p.userId, p.pnl]));
    const winnerPnl = pnlByUser.get('u1') ?? 0;
    const loserPnl = pnlByUser.get('u2') ?? 0;
    expect(winnerPnl).toBeCloseTo(expectedWinnerPnl);
    expect(winnerPnl).toBeGreaterThan(0);
    expect(loserPnl).toBeCloseTo(expectedLoserPnl);
    expect(loserPnl).toBeLessThan(0);
  });

  it('resolve with no losers still pays exactly 1 pt per winning share', async () => {
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      shares: 10,
      avgPrice: 999,
      status: 'active',
      pnl: 0,
      outcome: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const preBalance = (await wallet.getBalance('u1')).balance;

    await service.resolve({
      marketId: 'm1',
      winningSide: 'yes',
      resolutionDescription: 'No opposing bets — cost basis returned',
    });

    const pos = await db.getPosition('u1', 'm1', 'yes');
    const postBalance = (await wallet.getBalance('u1')).balance;

    expect(pos?.status).toBe('resolved');
    expect(pos?.outcome).toBe(true);
    // PRD §9.2 [D-14]: payout is shares x 1 pt regardless of cost basis
    // or of whether any losing positions exist. 10 shares pay 10 pts,
    // not the 9,990-pt cost basis the pool-proportional model returned.
    expect(postBalance - preBalance).toBeCloseTo(10);
    expect(pos?.pnl).toBeLessThan(0);
  });

  it('resolve pays a skewed-pool winner at 1 pt per share with cent settlement', async () => {
    // Skewed pool: YES is the cheap side, so a 100-pt buy accumulates
    // ~817 shares. Pool-proportional payout credited only ~109.89 for
    // this position; [D-14] requires the full share count at 1 pt each.
    const skewedDb = new InMemoryDb({
      id: 'm2',
      question: 'Skewed?',
      yesShares: 9000,
      noShares: 1000,
      liquidity: 10_000,
      endDate: new Date(Date.now() + 3600_000),
      resolved: false,
    });
    const skewedWallet = new InMemoryWallet();
    const skewedService = new PredictionMarketService({
      db: skewedDb,
      wallet: skewedWallet,
      broadcast: new InMemoryBroadcast(),
      cache: new InMemoryCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
    });
    await skewedService.buy({
      userId: 'u1',
      marketId: 'm2',
      side: 'yes',
      amount: 100,
    });
    await skewedService.buy({
      userId: 'u3',
      marketId: 'm2',
      side: 'no',
      amount: 10,
    });
    const pos = await skewedDb.getPosition('u1', 'm2', 'yes');
    expect(pos!.shares).toBeGreaterThan(800);
    const preBalance = (await skewedWallet.getBalance('u1')).balance;
    await skewedService.resolve({
      marketId: 'm2',
      winningSide: 'yes',
      resolutionDescription: 'Skewed pool resolves',
    });
    const credited = (await skewedWallet.getBalance('u1')).balance - preBalance;
    expect(credited).toBeCloseTo(floorPoints(pos!.shares), 8);
  });

  it('pricing getCurrentPrice returns 0.5 when total is zero for display', () => {
    expect(PredictionPricing.getCurrentPrice(0, 0, 'yes')).toBe(0.5);
  });
});

describe('PredictionMarketService input boundaries (D17)', () => {
  const baseMarket: PredictionMarketRecord = {
    id: 'mb',
    question: 'Boundary?',
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10_000,
    endDate: new Date('2030-01-01T00:00:00.000Z'),
    resolved: false,
  };

  function makeService(now: Date, db = new InMemoryDb(baseMarket)) {
    const wallet = new InMemoryWallet();
    const service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new InMemoryBroadcast(),
      cache: new InMemoryCache(),
      clock: { now: () => now },
      fees: feeConfig,
      feeProcessor: {
        processTradingFee: async () => ({ feeCharged: 0, referrerPaid: 0 }),
      },
    });
    return { service, wallet, db };
  }

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects non-finite buy amount %p before side effects', async (amount) => {
    const { service, wallet, db } = makeService(
      new Date('2029-01-01T00:00:00.000Z')
    );
    await expect(
      service.buy({ userId: 'u1', marketId: 'mb', side: 'yes', amount })
    ).rejects.toThrow('Trade amount must be at least');
    expect(wallet.balances.size).toBe(0);
    expect(db.positions.size).toBe(0);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects non-finite sell shares %p', async (shares) => {
    const { service } = makeService(new Date('2029-01-01T00:00:00.000Z'));
    await expect(
      service.sell({ userId: 'u1', marketId: 'mb', shares })
    ).rejects.toThrow('Shares to sell must be at least');
  });

  it('can sell a position holding exactly the minimum shares', async () => {
    const db = new InMemoryDb(baseMarket);
    await db.upsertPosition({
      userId: 'u1',
      marketId: 'mb',
      side: 'yes',
      shares: 0.01,
      avgPrice: 0.5,
      status: 'active',
    });
    const { service } = makeService(new Date('2029-01-01T00:00:00.000Z'), db);
    const result = await service.sell({
      userId: 'u1',
      marketId: 'mb',
      shares: 0.01,
    });
    expect(result.shares).toBeCloseTo(0.01);
  });

  it('uses the injected clock for buy expiry', async () => {
    const { service: expired } = makeService(
      new Date('2031-01-01T00:00:00.000Z')
    );
    await expect(
      expired.buy({ userId: 'u1', marketId: 'mb', side: 'yes', amount: 10 })
    ).rejects.toThrow('Market expired');
  });
});

describe('PredictionPricing boundaries (D17)', () => {
  it('rejects non-finite buy amounts and sell shares', () => {
    expect(() =>
      PredictionPricing.calculateBuy(5000, 5000, 'yes', Number.NaN)
    ).toThrow('Trade amount must be positive');
    expect(() =>
      PredictionPricing.calculateSell(5000, 5000, 'yes', Number.NaN)
    ).toThrow('Shares to sell must be positive');
  });
});
