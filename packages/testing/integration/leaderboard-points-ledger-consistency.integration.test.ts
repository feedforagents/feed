/**
 * Web points leaderboard (GET /api/leaderboard, metric=reputation) against a
 * real database: the score the board shows must be the user's points ledger,
 * continued.
 *
 * Two services move users.reputationPoints, and both write the ledger
 * (pointsTransactions) whose pointsBefore/pointsAfter chain the repo already
 * treats as the contract (see agent-chat-reputation.integration.test.ts):
 *
 * - ReputationService.awardReputation adds the award to the stored counter
 *   (a fresh user starts at the schema default, 1000) and files a ledger row
 *   for exactly that delta.
 * - EarnedPointsService — called by game onboarding step completion
 *   (awardBonusPoints) and by WalletService.recordPnL on every settled trade
 *   (awardEarnedPointsForPnL) — instead RECOMPUTES the counter from the
 *   point buckets with a base of 100: 100 + invite + earned + bonus.
 *
 * For every ordinary user (starting counter 1000) the first onboarding or
 * trade event therefore cuts the stored counter by 900 while its ledger row
 * records only the small earned delta: pointsAfter - pointsBefore != amount,
 * the chain breaks, and the leaderboard drops the user by 900 points for
 * earning points.
 *
 * Nothing is mocked: both services and the leaderboard reads run against the
 * real database, exactly as the routes call them. Fixtures are owned by this
 * suite and removed afterwards.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { ReputationService } from '@feed/api';
import { db, eq, inArray, pointsTransactions, users } from '@feed/db';
import { EarnedPointsService, WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const fixtureUserIds: string[] = [];

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const userId = await generateSnowflakeId();
  const username = `g36-user-${userId.slice(-8)}`;
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:g36-${userId}`,
    username,
    displayName: username,
    updatedAt: new Date(),
    ...overrides,
  });
  fixtureUserIds.push(userId);
  return userId;
}

async function getUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user;
}

/** Ledger rows for a user in chain order, with the chain itself verified. */
async function getLedger(userId: string) {
  const rows = await db
    .select()
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  return rows.sort((a, b) => a.pointsBefore - b.pointsBefore);
}

function expectContinuousLedger(
  rows: Awaited<ReturnType<typeof getLedger>>,
  startBalance: number
) {
  let expected = startBalance;
  for (const row of rows) {
    expect(row.pointsBefore).toBe(expected);
    expect(row.pointsAfter - row.pointsBefore).toBe(row.amount);
    expected = row.pointsAfter;
  }
  return expected;
}

afterAll(async () => {
  if (fixtureUserIds.length === 0) return;
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, fixtureUserIds));
  await db.delete(users).where(inArray(users.id, fixtureUserIds));
});

describe('points leaderboard score vs points ledger', () => {
  it('an onboarding bonus award does not cut the stored counter by 900', async () => {
    // Fresh user: schema default counter, no buckets, no ledger rows.
    const userId = await createUser();
    expect((await getUser(userId))?.reputationPoints).toBe(1000);

    // The profile award every sibling surface uses (ReputationService).
    await ReputationService.awardReputation(userId, 200, 'profile_completion');
    expect((await getUser(userId))?.reputationPoints).toBe(1200);

    // Completing a game onboarding step awards through EarnedPointsService.
    await EarnedPointsService.awardBonusPoints(
      userId,
      50,
      'onboarding_first_step'
    );

    const user = await getUser(userId);
    expect(user?.reputationPoints).toBe(1250);
    expect(user?.bonusPoints).toBe(250);

    const ledger = await getLedger(userId);
    expect(ledger).toHaveLength(2);
    expect(expectContinuousLedger(ledger, 1000)).toBe(1250);
  });

  it('recording trade PnL does not cut the stored counter by 900', async () => {
    const userId = await createUser();
    await ReputationService.awardReputation(userId, 300, 'twitter_link');
    expect((await getUser(userId))?.reputationPoints).toBe(1300);

    // A settled trade records its PnL through WalletService, which syncs
    // earned points inside the same transaction. $100 PnL = 10 points.
    const result = await WalletService.recordPnL(userId, 100, 'prediction');
    expect(result.earnedPointsDelta).toBe(10);

    const user = await getUser(userId);
    expect(user?.earnedPoints).toBe(10);
    expect(user?.reputationPoints).toBe(1310);

    const ledger = await getLedger(userId);
    expect(ledger).toHaveLength(2);
    expect(expectContinuousLedger(ledger, 1000)).toBe(1310);
  });

  it('the wallet leaderboard shows the ledger-backed score and rank', async () => {
    const userId = await createUser();
    await ReputationService.awardReputation(userId, 200, 'profile_completion');
    await EarnedPointsService.awardBonusPoints(
      userId,
      50,
      'onboarding_first_step'
    );

    const board = await ReputationService.getWalletLeaderboard(1, 100);
    const entry = board.users.find((candidate) => candidate.id === userId);
    expect(entry?.reputationPoints).toBe(1250);

    const position = await ReputationService.getUserPosition(
      userId,
      'wallet',
      100
    );
    expect(position?.entry.reputationPoints).toBe(1250);
    expect(position?.rank).toBe(entry?.rank);
  });

  it('tied users cross page boundaries exactly once with matching ranks', async () => {
    // Control axis: identical scores (and one identical createdAt pair) must
    // page without duplication or loss, and getUserPosition must agree with
    // the list order.
    const tieTime = new Date('2026-02-01T00:00:00.000Z');
    const tiedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      tiedIds.push(
        await createUser({
          reputationPoints: 777,
          createdAt: i < 2 ? tieTime : new Date(tieTime.getTime() + i * 1000),
        })
      );
    }

    const seen = new Map<string, number>();
    for (let page = 1; page <= 10; page++) {
      const board = await ReputationService.getWalletLeaderboard(page, 2);
      if (board.users.length === 0) break;
      for (const entry of board.users) {
        if (tiedIds.includes(entry.id)) {
          seen.set(entry.id, entry.rank);
        }
      }
    }
    expect(seen.size).toBe(5);

    for (const tiedId of tiedIds) {
      const position = await ReputationService.getUserPosition(
        tiedId,
        'wallet',
        2
      );
      expect(position?.rank).toBe(seen.get(tiedId));
    }
  });
});
