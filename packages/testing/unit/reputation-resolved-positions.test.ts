import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualDb from '@feed/db';
import * as actualShared from '@feed/shared';

type ColumnRef = { table: 'positions' | 'users'; column: string };

type Condition =
  | { op: 'and'; conditions: Array<Condition | undefined> }
  | { op: 'eq'; left: ColumnRef; right: unknown }
  | { op: 'gt'; left: ColumnRef; right: unknown }
  | { op: 'inArray'; left: ColumnRef; right: unknown[] };

type PositionRow = {
  id: string;
  userId: string;
  marketId: string;
  side: boolean;
  shares: string;
  status: string;
};

type UserRow = {
  id: string;
  nftTokenId: number | null;
  reputationPoints: number;
};

const positionsTable = {
  id: { table: 'positions', column: 'id' } as ColumnRef,
  userId: { table: 'positions', column: 'userId' } as ColumnRef,
  marketId: { table: 'positions', column: 'marketId' } as ColumnRef,
  side: { table: 'positions', column: 'side' } as ColumnRef,
  shares: { table: 'positions', column: 'shares' } as ColumnRef,
  status: { table: 'positions', column: 'status' } as ColumnRef,
};

const usersTable = {
  id: { table: 'users', column: 'id' } as ColumnRef,
  nftTokenId: { table: 'users', column: 'nftTokenId' } as ColumnRef,
  reputationPoints: {
    table: 'users',
    column: 'reputationPoints',
  } as ColumnRef,
};

let positionRows: PositionRow[] = [];
let userRows: UserRow[] = [];
let updatedUserIds: string[] = [];

function matchesCondition(
  row: Record<string, unknown>,
  condition: Condition | undefined
): boolean {
  if (!condition) return true;
  if (condition.op === 'and') {
    return condition.conditions.every((child) => matchesCondition(row, child));
  }
  const value = row[condition.left.column];
  if (condition.op === 'eq') {
    return value === condition.right;
  }
  if (condition.op === 'gt') {
    return Number(value) > Number(condition.right);
  }
  if (condition.op === 'inArray') {
    return condition.right.includes(value);
  }
  return false;
}

mock.module('@feed/shared', () => ({
  ...actualShared,
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module('@feed/db', () => ({
  ...actualDb,
  and: (...conditions: Array<Condition | undefined>): Condition => ({
    op: 'and',
    conditions,
  }),
  eq: (left: ColumnRef, right: unknown): Condition => ({
    op: 'eq',
    left,
    right,
  }),
  gt: (left: ColumnRef, right: unknown): Condition => ({
    op: 'gt',
    left,
    right,
  }),
  inArray: (left: ColumnRef, right: unknown[]): Condition => ({
    op: 'inArray',
    left,
    right,
  }),
  positions: positionsTable,
  users: usersTable,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async (condition: Condition) => {
          const source =
            table === positionsTable
              ? positionRows
              : table === usersTable
                ? userRows
                : [];
          return source.filter((row) => matchesCondition(row, condition));
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (condition: Condition) => ({
          returning: async () => {
            const matched = userRows.filter((row) =>
              matchesCondition(row, condition)
            );
            for (const user of matched) {
              updatedUserIds.push(user.id);
            }
            return matched.map((user) => ({
              reputationPoints: user.reputationPoints,
            }));
          },
        }),
      }),
    }),
  },
}));

const { ReputationService } = await import(
  '../../engine/src/services/reputation-service'
);

describe('ReputationService.updateReputationForResolvedMarket', () => {
  beforeEach(() => {
    updatedUserIds = [];
    userRows = [
      { id: 'u-winner', nftTokenId: 1, reputationPoints: 100 },
      { id: 'u-loser', nftTokenId: 2, reputationPoints: 100 },
      { id: 'u-exited', nftTokenId: 3, reputationPoints: 100 },
      { id: 'u-cancelled', nftTokenId: 4, reputationPoints: 100 },
      { id: 'u-zero', nftTokenId: 5, reputationPoints: 100 },
      { id: 'u-other-market', nftTokenId: 6, reputationPoints: 100 },
    ];
    positionRows = [
      {
        id: 'pos-winner',
        userId: 'u-winner',
        marketId: 'mkt-1',
        side: true,
        shares: '100.000000',
        status: 'resolved',
      },
      {
        id: 'pos-loser',
        userId: 'u-loser',
        marketId: 'mkt-1',
        side: false,
        shares: '50.000000',
        status: 'resolved',
      },
      {
        id: 'pos-exited-yes',
        userId: 'u-exited',
        marketId: 'mkt-1',
        side: true,
        shares: '0.000000',
        status: 'closed',
      },
      {
        id: 'pos-exited-no',
        userId: 'u-exited',
        marketId: 'mkt-1',
        side: false,
        shares: '0.000000',
        status: 'closed',
      },
      {
        id: 'pos-cancelled',
        userId: 'u-cancelled',
        marketId: 'mkt-1',
        side: true,
        shares: '25.000000',
        status: 'cancelled',
      },
      {
        id: 'pos-zero-resolved',
        userId: 'u-zero',
        marketId: 'mkt-1',
        side: true,
        shares: '0.000000',
        status: 'resolved',
      },
      {
        id: 'pos-other-market',
        userId: 'u-other-market',
        marketId: 'mkt-2',
        side: true,
        shares: '100.000000',
        status: 'resolved',
      },
    ];
  });

  test('scores only resolved positions with positive shares and excludes closed, cancelled, and zero-share rows', async () => {
    const updates = await ReputationService.updateReputationForResolvedMarket({
      marketId: 'mkt-1',
      outcome: true,
    });

    expect(updates).toEqual([
      { userId: 'u-winner', tokenId: 1, change: 10 },
      { userId: 'u-loser', tokenId: 2, change: -5 },
    ]);
    expect(updatedUserIds).toEqual(['u-winner', 'u-loser']);
  });
});
