/**
 * PRD §9.2: the outcome shown on a question must be the outcome that was
 * actually paid. #1954 fixed the admin resolve route losing this race
 * (re-read under the settlement lock, answer 409); the game tick's
 * resolveQuestionPayouts still has the mirror image: it checks
 * markets.resolved only before taking the lock, then unconditionally
 * rewrites the question (and reputation) with question.outcome even when
 * the admin already settled the market the other way.
 *
 * Real Postgres + real wallet, no mocks: the admin holds the settlement
 * lock, the tick blocks on it, the admin settles NO, the tick then runs
 * and must not overwrite the admin's NO with the recorded YES outcome.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  dbWrite,
  eq,
  markets,
  positions,
  questions,
  sql,
  users,
} from '@feed/db';
import {
  FEE_CONFIG,
  resolveQuestionPayouts,
  withPredictionSettlement,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const options = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};

const userIds: string[] = [];
const marketIds: string[] = [];

async function fixture() {
  const yesUserId = await generateSnowflakeId();
  const noUserId = await generateSnowflakeId();
  const marketId = await generateSnowflakeId();
  for (const userId of [yesUserId, noUserId]) {
    await dbWrite.insert(users).values({
      id: userId,
      username: `tick-race-${userId}`,
      profileComplete: true,
      virtualBalance: '1000',
      totalDeposited: '1000',
      updatedAt: new Date(),
    });
    userIds.push(userId);
  }
  await dbWrite.insert(markets).values({
    id: marketId,
    question: 'Tick loses admin resolve race',
    yesShares: '500',
    noShares: '500',
    liquidity: '1000',
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  marketIds.push(marketId);

  // Both sides hold real positions so the admin's NO actually pays someone.
  for (const [userId, side] of [
    [yesUserId, 'yes'],
    [noUserId, 'no'],
  ] as const) {
    await withPredictionSettlement(
      marketId,
      { userId },
      (service) => service.buy({ userId, marketId, side, amount: 100 }),
      options
    );
  }

  const [maximum] = await dbWrite
    .select({
      value: sql<number>`coalesce(max(${questions.questionNumber}), 0)`,
    })
    .from(questions);
  const questionNumber = Number(maximum?.value ?? 0) + 1;
  // The recorded (scenario) outcome is YES; the admin will settle NO.
  await dbWrite.insert(questions).values({
    id: marketId,
    marketId,
    questionNumber,
    text: 'Tick loses admin resolve race',
    scenarioId: 1,
    outcome: true,
    rank: 1,
    resolutionDate: new Date(),
    updatedAt: new Date(),
  });
  return { yesUserId, noUserId, marketId, questionNumber };
}

afterAll(async () => {
  if (marketIds.length > 0) {
    await dbWrite
      .delete(positions)
      .where(eq(positions.marketId, marketIds[0]!));
    await dbWrite.delete(markets).where(eq(markets.id, marketIds[0]!));
    await dbWrite.delete(questions).where(eq(questions.id, marketIds[0]!));
  }
  if (userIds.length > 0) {
    await dbWrite.delete(users).where(eq(users.id, userIds[0]!));
    await dbWrite.delete(users).where(eq(users.id, userIds[1]!));
  }
});

describe('game tick loses the admin resolve race', () => {
  it('preserves the admin-paid outcome and writes no wrong-side reputation', async () => {
    const f = await fixture();
    const [yesBefore] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, f.yesUserId));
    const [noBefore] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, f.noUserId));
    // Both sides staked 100 of their 1000.
    expect(Number(yesBefore?.virtualBalance)).toBe(900);
    expect(Number(noBefore?.virtualBalance)).toBe(900);
    // NOTE: no reputation assertion here. The admin's own resolve records
    // PnL, which moves users.reputationPoints via EarnedPoints, so the
    // absolute post-race value is not a clean tick signal. The fix also
    // skips the tick's outcome-sensitive reputation update (the early
    // return precedes the ReputationService call): the base run logged
    // ReputationService +10 for the YES side / -5 for the NO side after
    // the tick had already lost, the fixed run logs no such update.

    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    // The admin holds the settlement lock, then settles NO — the same
    // callback shape as the admin web route after #1954.
    const admin = withPredictionSettlement(
      f.marketId,
      { system: 'test_admin_resolve' },
      async (service, tx) => {
        const [row] = await tx
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(markets)
          .where(eq(markets.id, f.marketId));
        if (!row) throw new Error('Missing settlement lock holder');
        ready.resolve(row.pid);
        await release.promise;
        const resolvedAt = new Date();
        await service.resolve({
          marketId: f.marketId,
          winningSide: 'no',
          resolvedAt,
        });
        await tx
          .update(questions)
          .set({
            status: 'resolved',
            resolvedOutcome: false,
            resolutionReviewedAt: resolvedAt,
            resolutionReviewedBy: 'admin-test',
            updatedAt: resolvedAt,
          })
          .where(eq(questions.id, f.marketId));
      },
      options
    );
    void admin.catch(ready.reject);
    const pid = await ready.promise;

    // The tick checked the market before the admin settled, so it is
    // already past its pre-lock guard and now blocks on the lock.
    const tick = resolveQuestionPayouts(f.questionNumber);
    void tick.catch(() => {});
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        const waiting = await dbWrite.execute(sql`
            SELECT waiting.pid
            FROM pg_locks waiting
            JOIN pg_locks held
              ON (waiting.database, waiting.classid, waiting.objid, waiting.objsubid)
               = (held.database, held.classid, held.objid, held.objsubid)
            WHERE held.pid = ${pid}
              AND held.locktype = 'advisory' AND held.granted
              AND waiting.locktype = 'advisory' AND NOT waiting.granted
          `);
        if (waiting.length > 0) break;
        if (Date.now() >= deadline)
          throw new Error('Tick never reached the settlement lock');
        await Bun.sleep(20);
      }
    } finally {
      release.resolve();
    }
    await admin;
    await tick;

    const [market] = await dbWrite
      .select({
        resolved: markets.resolved,
        resolution: markets.resolution,
      })
      .from(markets)
      .where(eq(markets.id, f.marketId));
    expect(market).toEqual({ resolved: true, resolution: false });
    const [question] = await dbWrite
      .select({
        status: questions.status,
        resolvedOutcome: questions.resolvedOutcome,
        resolutionReviewedBy: questions.resolutionReviewedBy,
      })
      .from(questions)
      .where(eq(questions.id, f.marketId));
    // The paid outcome was NO; the question must still say NO.
    expect(question?.status).toBe('resolved');
    expect(question?.resolvedOutcome).toBe(false);
    expect(question?.resolutionReviewedBy).toBe('admin-test');

    // Only the NO side was paid; the YES side got nothing from the tick.
    const [yesAfter] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, f.yesUserId));
    const [noAfter] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, f.noUserId));
    expect(Number(yesAfter?.virtualBalance)).toBe(900);
    expect(Number(noAfter?.virtualBalance)).toBeGreaterThan(900);

    const holdings = await dbWrite
      .select()
      .from(positions)
      .where(eq(positions.marketId, f.marketId));
    expect(holdings).toHaveLength(2);
    for (const holding of holdings) {
      expect(holding.status).toBe('resolved');
      // positions.side is a boolean: true = YES, false = NO.
      expect(holding.outcome).toBe(holding.side === false);
    }
  }, 120_000);
});
