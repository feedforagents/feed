import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  BroadcastPort,
  CachePort,
  FeeProcessor,
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

// Production fee config (packages/engine FEE_CONFIG, mirrored in the
// PredictionMarketService suite): positions carry a net-of-fee cost basis,
// so a buy of 1000 pts at a 0.1% fee puts 999 pts of cost basis on the book.
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

  async listMarkets(): Promise<PredictionMarketRecord[]> {
    return Array.from(this.markets.values()).map((m) => ({ ...m }));
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

describe('PredictionMarketService cancel refunds', () => {
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
  let feeProcessor: FeeProcessor;
  let feeCalls: { amount: number; type: string }[];
  let service: PredictionMarketService;

  beforeEach(() => {
    db = new InMemoryDb(market);
    wallet = new InMemoryWallet();
    feeCalls = [];
    feeProcessor = {
      processTradingFee: async ({ amount, type }) => {
        feeCalls.push({ amount, type });
        return { feeCharged: 0, referrerPaid: 0 };
      },
    };
    service = new PredictionMarketService({
      db,
      wallet,
      broadcast: new InMemoryBroadcast(),
      cache: new InMemoryCache(),
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
    });
  });

  it('cancel refunds net cost basis; the distributed entry fee stays distributed', async () => {
    const buyResult = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 1000,
    });
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(9000, 6);

    const result = await service.cancel({
      marketId: 'm1',
      reason: 'Voided by admin',
    });

    expect(result.positionsRefunded).toBe(1);
    // The buy debited 1000 pts, of which 1 pt was the entry fee that buy()
    // already distributed via processTradingFee (no reversal exists), so
    // cancel refunds the 999 pts of net cost basis — refunding the full
    // debit would mint the distributed fee a second time.
    expect(result.totalRefunded).toBeCloseTo(999, 6);
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(9999, 6);
    const cancelPnl = wallet.pnls.find((p) => p.reason === 'pred_cancel');
    expect(cancelPnl?.pnl).toBeCloseTo(-1, 6);
    // Conservation: refund + fee charged at buy == debit, and cancel runs
    // no fee processing of its own.
    expect(result.totalRefunded + buyResult.feePaid).toBeCloseTo(1000, 6);
    expect(feeCalls.filter((c) => c.type === 'pred_buy').length).toBe(1);
    expect(feeCalls.filter((c) => c.type === 'pred_cancel').length).toBe(0);
  });

  it('cancel refunds every buyer their net cost basis, across sides', async () => {
    const buy1 = await service.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 1000,
    });
    const buy2 = await service.buy({
      userId: 'u2',
      marketId: 'm1',
      side: 'no',
      amount: 500,
    });

    const result = await service.cancel({
      marketId: 'm1',
      reason: 'Voided by admin',
    });

    expect(result.positionsRefunded).toBe(2);
    expect(result.totalRefunded).toBeCloseTo(1498.5, 6);
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(9999, 6);
    expect((await wallet.getBalance('u2')).balance).toBeCloseTo(9999.5, 6);
    expect(
      result.totalRefunded + buy1.feePaid + buy2.feePaid
    ).toBeCloseTo(1500, 6);
  });

  it('with a zero fee rate the refund still equals the debit (no gross-up)', async () => {
    const freeService = new PredictionMarketService({
      db,
      wallet,
      broadcast: new InMemoryBroadcast(),
      cache: new InMemoryCache(),
      clock: { now: () => new Date() },
      fees: { ...feeConfig, tradingFeeRate: 0 },
      feeProcessor,
    });

    await freeService.buy({
      userId: 'u1',
      marketId: 'm1',
      side: 'yes',
      amount: 1000,
    });
    const result = await freeService.cancel({
      marketId: 'm1',
      reason: 'Voided by admin',
    });

    expect(result.totalRefunded).toBeCloseTo(1000, 6);
    expect((await wallet.getBalance('u1')).balance).toBeCloseTo(10_000, 6);
  });
});
