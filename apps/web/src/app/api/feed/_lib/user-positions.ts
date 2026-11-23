import { and, db, eq, gte, inArray, isNotNull, or, positions } from '@feed/db';

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
 * Load active prediction positions for `userId` matching any of `stories`.
 * PredictionDbAdapter stores the market link in `positions.marketId` with
 * `positions.questionId = null`, while legacy rows may populate
 * `positions.questionId`. Match both and require sellable shares (>= 0.01).
 */
export async function loadUserActiveStoryPositions(
  userId: string,
  stories: readonly StoryPositionTarget[]
): Promise<Array<{ marketId: string; questionId: number | null }>> {
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
    return [];
  }

  return db
    .select({
      marketId: positions.marketId,
      questionId: positions.questionId,
    })
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.status, 'active'),
        gte(positions.shares, '0.01'),
        matchers.length === 1 ? matchers[0] : or(...matchers)
      )
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
