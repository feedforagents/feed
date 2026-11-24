import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as actualDb from '@feed/db';

interface MockPositionRow {
  id: string;
  marketId: string;
  userId: string;
  side: boolean;
  shares: string;
  status: string;
}

interface MockUserRow {
  id: string;
  nftTokenId: number | null;
  reputationPoints: number;
}

let mockPositions: MockPositionRow[] = [];
let mockUsers: MockUserRow[] = [];
const updatedUsers: Array<{ userId: string }> = [];

mock.module('@feed/db', () => ({
  ...actualDb,
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  inArray: (left: unknown, right: unknown[]) => ({
    op: 'inArray',
    left,
    right,
  }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async (cond: { right?: unknown }) => {
          if (table === actualDb.positions) {
            return mockPositions.filter((p) => p.marketId === cond.right);
          }
          if (table === actualDb.users) {
            const ids = Array.isArray(cond.right) ? cond.right : [cond.right];
            return mockUsers.filter((u) => ids.includes(u.id));
          }
          return [];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (cond: { right?: string }) => ({
          returning: async () => {
            const userId = String(cond.right ?? '');
            updatedUsers.push({ userId });
            const user = mockUsers.find((u) => u.id === userId);
            return [{ reputationPoints: user?.reputationPoints ?? 0 }];
          },
        }),
      }),
    }),
  },
}));

const { ReputationService } = await import(
  '../../engine/src/services/reputation-service'
);

describe('ReputationService.updateReputationForResolvedMarket user-side deduplication', () => {
  beforeEach(() => {
    updatedUsers.length = 0;
    mockUsers = [
      { id: 'u1', nftTokenId: 1, reputationPoints: 100 },
      { id: 'u2', nftTokenId: 2, reputationPoints: 100 },
    ];
    mockPositions = [
      // u1 closed YES twice and then held a resolved YES row (3 rows, same user+side)
      {
        id: 'p1',
        marketId: 'm1',
        userId: 'u1',
        side: true,
        shares: '0',
        status: 'closed',
      },
      {
        id: 'p2',
        marketId: 'm1',
        userId: 'u1',
        side: true,
        shares: '0',
        status: 'closed',
      },
      {
        id: 'p3',
        marketId: 'm1',
        userId: 'u1',
        side: true,
        shares: '25',
        status: 'resolved',
      },
      // u1 also had two NO rows (closed + resolved): scored at most once for NO
      {
        id: 'p4',
        marketId: 'm1',
        userId: 'u1',
        side: false,
        shares: '0',
        status: 'closed',
      },
      {
        id: 'p5',
        marketId: 'm1',
        userId: 'u1',
        side: false,
        shares: '10',
        status: 'resolved',
      },
      // Separate user u2 on YES must still be scored independently
      {
        id: 'p6',
        marketId: 'm1',
        userId: 'u2',
        side: true,
        shares: '15',
        status: 'resolved',
      },
    ];
  });

  it('scores each (userId, side) at most once when re-entry leaves prior closed rows', async () => {
    const results = await ReputationService.updateReputationForResolvedMarket({
      marketId: 'm1',
      outcome: true,
    });

    expect(results).toEqual([
      { userId: 'u1', tokenId: 1, change: 10 },
      { userId: 'u1', tokenId: 1, change: -5 },
      { userId: 'u2', tokenId: 2, change: 10 },
    ]);
    expect(updatedUsers).toHaveLength(3);
  });
});
