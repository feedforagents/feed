import { and, eq, gte, inArray, isNotNull, or, positions } from '@feed/db';

export interface StoryPositionTarget {
  questionNumber: number | null;
  marketId?: string | null;
}

export interface UserStoryPositionRow {
  marketId?: string | null;
  questionId: number | null;
}

export interface UserStoryPositionIndex {
  marketIds: Set<string>;
  questionNumbers: Set<number>;
}

/**
 * Build the WHERE predicate for active sellable prediction positions held by
 * `userId` on any of `stories`. PredictionDbAdapter stores the market link in
 * `positions.marketId` with `positions.questionId = null`, while legacy rows
 * may populate `positions.questionId`. Returns null when no stories carry a
 * marketId or questionNumber so callers can skip the query.
 */
export function buildUserActiveStoryPositionsWhere(
  userId: string,
  stories: readonly StoryPositionTarget[]
) {
  const marketIds = Array.from(
    new Set(
      stories
        .map((story) => story.marketId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  );
  const questionNumbers = Array.from(
    new Set(
      stories
        .map((story) => story.questionNumber)
        .filter((num): num is number => num !== null)
    )
  );

  const matchers = [
    ...(marketIds.length > 0 ? [inArray(positions.marketId, marketIds)] : []),
    ...(questionNumbers.length > 0
      ? [
          and(
            isNotNull(positions.questionId),
            inArray(positions.questionId, questionNumbers)
          ),
        ]
      : []),
  ];

  if (matchers.length === 0) {
    return null;
  }

  return and(
    eq(positions.userId, userId),
    eq(positions.status, 'active'),
    gte(positions.shares, '0.01'),
    matchers.length === 1 ? matchers[0] : or(...matchers)
  );
}

export function buildUserStoryPositionIndex(
  rows: readonly UserStoryPositionRow[]
): UserStoryPositionIndex {
  const marketIds = new Set<string>();
  const questionNumbers = new Set<number>();
  for (const row of rows) {
    if (row.marketId) {
      marketIds.add(row.marketId);
    }
    if (row.questionId !== null) {
      questionNumbers.add(row.questionId);
    }
  }
  return { marketIds, questionNumbers };
}

export function storyHasUserPosition(
  story: StoryPositionTarget,
  positionsIndex: UserStoryPositionIndex
): boolean {
  if (story.marketId && positionsIndex.marketIds.has(story.marketId)) {
    return true;
  }
  return (
    story.questionNumber !== null &&
    positionsIndex.questionNumbers.has(story.questionNumber)
  );
}
