import { describe, expect, it, mock } from 'bun:test';
import * as actualDb from '@feed/db';

type ColumnRef = { column: string };

type Condition =
  | { op: 'and'; conditions: Array<Condition | undefined> }
  | { op: 'or'; conditions: Array<Condition | undefined> }
  | { op: 'eq'; left: ColumnRef; right: unknown }
  | { op: 'gte'; left: ColumnRef; right: unknown }
  | { op: 'inArray'; left: ColumnRef; right: unknown[] }
  | { op: 'isNotNull'; left: ColumnRef };

type PositionRow = {
  userId: string;
  marketId: string;
  questionId: number | null;
  status: string;
  shares: string;
};

const positionsTable = {
  userId: { column: 'userId' } as ColumnRef,
  marketId: { column: 'marketId' } as ColumnRef,
  questionId: { column: 'questionId' } as ColumnRef,
  status: { column: 'status' } as ColumnRef,
  shares: { column: 'shares' } as ColumnRef,
};

function matchesCondition(
  row: Record<string, unknown>,
  condition: Condition | undefined
): boolean {
  if (!condition) return true;
  if (condition.op === 'and' || condition.op === 'or') {
    return condition.op === 'and'
      ? condition.conditions.every((child) => matchesCondition(row, child))
      : condition.conditions.some((child) => matchesCondition(row, child));
  }
  const value = row[condition.left.column];
  if (condition.op === 'eq') {
    return value === condition.right;
  }
  if (condition.op === 'gte') {
    return Number(value) >= Number(condition.right);
  }
  if (condition.op === 'inArray') {
    return condition.right.includes(value);
  }
  if (condition.op === 'isNotNull') {
    return value !== null && value !== undefined;
  }
  return false;
}

mock.module('@feed/db', () => ({
  ...actualDb,
  and: (...conditions: Array<Condition | undefined>): Condition => ({
    op: 'and',
    conditions,
  }),
  or: (...conditions: Array<Condition | undefined>): Condition => ({
    op: 'or',
    conditions,
  }),
  eq: (left: ColumnRef, right: unknown): Condition => ({
    op: 'eq',
    left,
    right,
  }),
  gte: (left: ColumnRef, right: unknown): Condition => ({
    op: 'gte',
    left,
    right,
  }),
  inArray: (left: ColumnRef, right: unknown[]): Condition => ({
    op: 'inArray',
    left,
    right,
  }),
  isNotNull: (left: ColumnRef): Condition => ({
    op: 'isNotNull',
    left,
  }),
  positions: positionsTable,
}));

const {
  buildUserActiveStoryPositionsWhere,
  buildUserStoryPositionIndex,
  storyHasUserPosition,
} = await import('./user-positions');

const fixtureRows: PositionRow[] = [
  // Production row written by PredictionDbAdapter (questionId is always null)
  {
    userId: 'u1',
    marketId: 'mkt-12',
    questionId: null,
    status: 'active',
    shares: '100.000000',
  },
  // Exact minimum sellable share boundary (0.01)
  {
    userId: 'u1',
    marketId: 'mkt-min-lot',
    questionId: null,
    status: 'active',
    shares: '0.010000',
  },
  // Legacy row populated with questionId
  {
    userId: 'u1',
    marketId: 'mkt-legacy-other',
    questionId: 7,
    status: 'active',
    shares: '50.000000',
  },
  // Dust / zero-share active row (must be excluded)
  {
    userId: 'u1',
    marketId: 'mkt-dust',
    questionId: null,
    status: 'active',
    shares: '0.005000',
  },
  // Closed / resolved rows (must be excluded)
  {
    userId: 'u1',
    marketId: 'mkt-closed',
    questionId: null,
    status: 'closed',
    shares: '0.000000',
  },
  {
    userId: 'u1',
    marketId: 'mkt-resolved',
    questionId: null,
    status: 'resolved',
    shares: '50.000000',
  },
  // Another user's active position on a visible market (must be excluded)
  {
    userId: 'u2',
    marketId: 'mkt-other-user',
    questionId: null,
    status: 'active',
    shares: '100.000000',
  },
];

describe('feed user story position matching', () => {
  it('matches active PredictionDbAdapter positions by marketId when questionId is null and preserves legacy questionId matching', () => {
    const stories = [
      { questionNumber: 12, marketId: 'mkt-12' },
      { questionNumber: 13, marketId: 'mkt-min-lot' },
      { questionNumber: 7, marketId: null },
      { questionNumber: 14, marketId: 'mkt-dust' },
      { questionNumber: 15, marketId: 'mkt-closed' },
      { questionNumber: 16, marketId: 'mkt-resolved' },
      { questionNumber: 17, marketId: 'mkt-other-user' },
      { questionNumber: null, marketId: null },
    ];

    const where = buildUserActiveStoryPositionsWhere(
      'u1',
      stories
    ) as unknown as Condition | null;
    expect(where).not.toBeNull();

    const rows = fixtureRows
      .filter((row) => matchesCondition(row, where ?? undefined))
      .map(({ marketId, questionId }) => ({ marketId, questionId }));

    expect(rows).toEqual([
      { marketId: 'mkt-12', questionId: null },
      { marketId: 'mkt-min-lot', questionId: null },
      { marketId: 'mkt-legacy-other', questionId: 7 },
    ]);

    const index = buildUserStoryPositionIndex(rows);
    expect(storyHasUserPosition(stories[0]!, index)).toBe(true);
    expect(storyHasUserPosition(stories[1]!, index)).toBe(true);
    expect(storyHasUserPosition(stories[2]!, index)).toBe(true);
    expect(storyHasUserPosition(stories[3]!, index)).toBe(false);
    expect(storyHasUserPosition(stories[4]!, index)).toBe(false);
    expect(storyHasUserPosition(stories[5]!, index)).toBe(false);
    expect(storyHasUserPosition(stories[6]!, index)).toBe(false);
    expect(storyHasUserPosition(stories[7]!, index)).toBe(false);
  });

  it('handles marketId-only, questionNumber-only, and empty story lists cleanly', () => {
    const marketWhere = buildUserActiveStoryPositionsWhere('u1', [
      { questionNumber: null, marketId: 'mkt-12' },
    ]) as unknown as Condition | null;
    expect(marketWhere).not.toBeNull();
    expect(
      fixtureRows
        .filter((row) => matchesCondition(row, marketWhere ?? undefined))
        .map(({ marketId, questionId }) => ({ marketId, questionId }))
    ).toEqual([{ marketId: 'mkt-12', questionId: null }]);

    const questionWhere = buildUserActiveStoryPositionsWhere('u1', [
      { questionNumber: 7, marketId: null },
    ]) as unknown as Condition | null;
    expect(questionWhere).not.toBeNull();
    expect(
      fixtureRows
        .filter((row) => matchesCondition(row, questionWhere ?? undefined))
        .map(({ marketId, questionId }) => ({ marketId, questionId }))
    ).toEqual([{ marketId: 'mkt-legacy-other', questionId: 7 }]);

    expect(
      buildUserActiveStoryPositionsWhere('u1', [
        { questionNumber: null, marketId: null },
        { questionNumber: null, marketId: '' },
      ])
    ).toBeNull();
  });

  it('stays backward compatible with cached rows lacking marketId', () => {
    const legacyIndex = buildUserStoryPositionIndex([{ questionId: 7 }]);
    expect(
      storyHasUserPosition(
        { questionNumber: 7, marketId: 'mkt-7' },
        legacyIndex
      )
    ).toBe(true);
    expect(
      storyHasUserPosition(
        { questionNumber: 8, marketId: 'mkt-8' },
        legacyIndex
      )
    ).toBe(false);
  });
});
