/**
 * PRD §9.2 / MVP Phase 6: stored manual reviews retain their funded positions
 * until approval. This real full-cron regression owns a fresh child database.
 * Future occupied main/submarket inventory keeps unrelated generation unnecessary;
 * it is fixture state, not evidence of LLM-generated questions or canonical capacity.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runIsolatedMarketsReviewCases,
  verifyMarketsReviewChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_MARKETS_REVIEW_CHILD) {
  test('runs funded manual review and resolution races in a leased fresh database', async () => {
    await runIsolatedMarketsReviewCases();
  }, 300_000);
} else {
  // No application imports or fixture writes before positive child ownership.
  await verifyMarketsReviewChildLease();
  const leaseFile = process.env.FEED_MARKETS_REVIEW_LEASE_FILE;
  if (!leaseFile) throw new Error('Verified manual-review lease is required');
  const receiptPath = join(dirname(leaseFile), 'fixture-receipts.jsonl');
  writeFileSync(receiptPath, '', { flag: 'wx', mode: 0o600 });
  const {
    adminAuditLogs,
    balanceTransactions,
    closeDatabase,
    db,
    eq,
    games,
    inArray,
    markets,
    positions,
    posts,
    predictionResolutionWork,
    questions,
    sql,
    timeframedMarkets,
    users,
  } = await import('@feed/db');
  const recoveryMigration = await Bun.file(
    new URL(
      '../../db/drizzle/migrations/manual/0008_prediction_resolution_work.sql',
      import.meta.url
    )
  ).text();
  await db.execute(sql.raw(recoveryMigration));
  const { FEE_CONFIG, mapGranularToDbTimeframe, withPredictionSettlement } =
    await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { getAdminToken } = await import('./helpers');
  setDefaultTimeout(120000);

  type PhysicalRow = { id: string; canonical: string };
  type Support = {
    questions: PhysicalRow[];
    markets: PhysicalRow[];
    timeframed: PhysicalRow[];
  };
  type Fixture = {
    questionId: string;
    timeframedId: string;
    userId: string;
    payout: number;
    proofId: string;
  };
  type Review = 'pending' | 'unset' | 'rejected' | 'approved';
  let support: Support;
  function remember(table: string, rows: PhysicalRow[]) {
    // Publish immutable physical INSERT/UPDATE RETURNING receipts only after commit.
    for (const row of rows)
      appendFileSync(receiptPath, JSON.stringify({ table, ...row }) + '\n', {
        mode: 0o600,
      });
  }
  const originalCronSecret = process.env.CRON_SECRET;
  const originalGameStart = process.env.GAME_START;
  const originalRelay = process.env.REDIRECT_CRON_STAGING;
  const originalDeployment = process.env.DEPLOYMENT_ENV;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'review-hold-integration';
    process.env.GAME_START = 'true';
    process.env.REDIRECT_CRON_STAGING = 'false';
    process.env.DEPLOYMENT_ENV = 'localnet';
    expect(await db.select({ id: games.id }).from(games)).toHaveLength(0);
    expect(await db.select({ id: questions.id }).from(questions)).toHaveLength(
      0
    );
    expect(
      await db.select({ id: timeframedMarkets.id }).from(timeframedMarkets)
    ).toHaveLength(0);
    const gameId = await generateSnowflakeId();
    const slots = [
      ['3d', 1, 3 * 86400000],
      ['2d', 1, 2 * 86400000],
      ['1d', 1, 86400000],
      ['12h', 1, 43200000],
      ['6h', 1, 21600000],
      ['1h', 1, 3600000],
      ['30m', 2, 1800000],
      ['15m', 2, 900000],
    ] as const;
    const prepared: {
      questionId: string;
      timeframedId: string;
      timeframe: '3d' | '2d' | '1d' | '12h' | '6h' | '1h' | '30m' | '15m';
      duration: number;
      parentId: string | null;
    }[] = [];
    for (const [timeframe, count, duration] of slots) {
      for (let i = 0; i < count; i++)
        prepared.push({
          questionId: await generateSnowflakeId(),
          timeframedId: await generateSnowflakeId(),
          timeframe,
          duration,
          parentId: null,
        });
    }
    const parent = prepared[0];
    if (!parent) throw new Error('Future parent fixture is missing');
    for (let i = 0; i < 10; i++)
      prepared.push({
        questionId: await generateSnowflakeId(),
        timeframedId: await generateSnowflakeId(),
        timeframe: '15m',
        duration: 900000,
        parentId: parent.timeframedId,
      });
    const now = new Date();
    const acquired = await db.transaction(async (tx) => {
      const game = await tx
        .insert(games)
        .values({
          id: gameId,
          isContinuous: true,
          isRunning: true,
          currentDay: 1,
          updatedAt: now,
        })
        .returning({
          id: games.id,
          canonical: sql<string>`to_jsonb(${games})::text`,
        });
      const q = await tx
        .insert(questions)
        .values(
          prepared.map((p, i) => ({
            id: p.questionId,
            questionNumber: i + 1,
            text: `Manual-review occupied future inventory ${p.questionId}`,
            scenarioId: 1,
            outcome: true,
            rank: 1,
            createdDate: now,
            resolutionDate: new Date(now.getTime() + p.duration),
            status: 'active' as const,
            updatedAt: now,
          }))
        )
        .returning({
          id: questions.id,
          canonical: sql<string>`to_jsonb(${questions})::text`,
        });
      const m = await tx
        .insert(markets)
        .values(
          prepared.map((p) => ({
            id: p.questionId,
            question: `Manual-review occupied future inventory ${p.questionId}`,
            liquidity: '10000',
            yesShares: '5000',
            noShares: '5000',
            endDate: new Date(now.getTime() + p.duration),
            updatedAt: now,
          }))
        )
        .returning({
          id: markets.id,
          canonical: sql<string>`to_jsonb(${markets})::text`,
        });
      const t = await tx
        .insert(timeframedMarkets)
        .values(
          prepared.map((p) => ({
            id: p.timeframedId,
            questionId: p.questionId,
            timeframe: mapGranularToDbTimeframe(p.timeframe),
            granularTimeframe: p.timeframe,
            parentMarketId: p.parentId,
            startTime: now,
            endTime: new Date(now.getTime() + p.duration),
            isActive: true,
            isResolved: false,
            arcStateEnteredAt: now,
          }))
        )
        .returning({
          id: timeframedMarkets.id,
          canonical: sql<string>`to_jsonb(${timeframedMarkets})::text`,
        });
      return { game, questions: q, markets: m, timeframed: t };
    });
    remember('Game', acquired.game);
    remember('Question', acquired.questions);
    remember('Market', acquired.markets);
    remember('TimeframedMarket', acquired.timeframed);
    expect(acquired.game).toHaveLength(1);
    for (const rows of [
      acquired.questions,
      acquired.markets,
      acquired.timeframed,
    ])
      expect(rows).toHaveLength(20);
    support = {
      questions: acquired.questions,
      markets: acquired.markets,
      timeframed: acquired.timeframed,
    };
  });

  afterAll(async () => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalGameStart === undefined) delete process.env.GAME_START;
    else process.env.GAME_START = originalGameStart;
    if (originalRelay === undefined) delete process.env.REDIRECT_CRON_STAGING;
    else process.env.REDIRECT_CRON_STAGING = originalRelay;
    if (originalDeployment === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = originalDeployment;
    // No row cleanup: only the existing positive-lease whole-child DROP on pass.
    // A failed child and every acquired physical receipt are retained.
    await closeDatabase();
  }, 10_000);

  async function seedEndedMarket(review: Review) {
    const now = Date.now();
    const questionId = await generateSnowflakeId();
    const timeframedId = await generateSnowflakeId();
    const userId = await generateSnowflakeId();
    const proofId = await generateSnowflakeId();
    const fixture = { questionId, timeframedId, userId, payout: 0, proofId };
    const resolutionDate = new Date(now - 60000);
    const [max] = await db
      .select({ max: sql<number>`COALESCE(MAX("questionNumber"), 0)` })
      .from(questions);
    const text = `Integration test: review hold ${review} ${questionId}`;
    const acquired = await db.transaction(async (tx) => {
      const u = await tx
        .insert(users)
        .values({
          id: userId,
          username: `review-hold-${userId}`,
          virtualBalance: '500',
          totalDeposited: '500',
          updatedAt: new Date(),
        })
        .returning({
          id: users.id,
          canonical: sql<string>`to_jsonb(${users})::text`,
        });
      const q = await tx
        .insert(questions)
        .values({
          id: questionId,
          questionNumber: Number(max?.max ?? 0) + 1,
          text,
          scenarioId: 1,
          outcome: true,
          rank: 1,
          createdDate: new Date(now - 3600000),
          status: 'active',
          updatedAt: new Date(),
          resolutionConfidence: 0.3,
          ...(review === 'rejected'
            ? {
                requiresManualReview: false,
                resolutionReviewStatus: 'rejected',
                resolutionDate: new Date(now + 24 * 3600000),
              }
            : {
                requiresManualReview: true,
                resolutionReviewStatus: review === 'unset' ? null : review,
                resolutionDate,
                resolutionDescription: 'Low-confidence proof',
              }),
        })
        .returning({
          id: questions.id,
          canonical: sql<string>`to_jsonb(${questions})::text`,
        });
      const m = await tx
        .insert(markets)
        .values({
          id: questionId,
          question: text,
          liquidity: '10000',
          yesShares: '5000',
          noShares: '5000',
          endDate: new Date(now + 3600000),
          updatedAt: new Date(),
        })
        .returning({
          id: markets.id,
          canonical: sql<string>`to_jsonb(${markets})::text`,
        });
      if (review !== 'rejected') {
        await tx.insert(predictionResolutionWork).values({
          questionId,
          resolutionDate,
          outcome: true,
          draft: {
            description: 'Low-confidence proof',
            confidence: 0.3,
            requiresManualReview: true,
            post: {
              id: proofId,
              type: 'proof',
              authorId: userId,
              content: 'Low-confidence proof',
              fullContent: 'A generated proof awaits review.',
              articleTitle: 'Resolution proof',
            },
          },
        });
      }
      return { u, q, m };
    });
    remember('User', acquired.u);
    remember('Question', acquired.q);
    remember('Market', acquired.m);
    for (const rows of [acquired.u, acquired.q, acquired.m])
      expect(rows).toHaveLength(1);
    const bought = await withPredictionSettlement(
      questionId,
      { userId },
      (service) =>
        service.buy({ userId, marketId: questionId, side: 'yes', amount: 100 }),
      {
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
      }
    );
    const [held] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, bought.positionId));
    expect(held).toBeDefined();
    fixture.payout = Math.floor(Number(held!.shares) * 100) / 100;
    const ended = await db.transaction(async (tx) => {
      const m = await tx
        .update(markets)
        .set({ endDate: new Date(now - 60000) })
        .where(eq(markets.id, questionId))
        .returning({
          id: markets.id,
          canonical: sql<string>`to_jsonb(${markets})::text`,
        });
      const t = await tx
        .insert(timeframedMarkets)
        .values({
          id: timeframedId,
          questionId,
          timeframe: 'intraday',
          startTime: new Date(now - 3600000),
          endTime: new Date(now - 60000),
          isActive: true,
          isResolved: false,
          arcStateEnteredAt: new Date(now - 3600000),
        })
        .returning({
          id: timeframedMarkets.id,
          canonical: sql<string>`to_jsonb(${timeframedMarkets})::text`,
        });
      return { m, t };
    });
    remember('Market', ended.m);
    remember('TimeframedMarket', ended.t);
    expect(ended.m).toHaveLength(1);
    expect(ended.t).toHaveLength(1);
    return fixture;
  }

  async function stateOf(ids: Fixture) {
    const [q] = await db
      .select({ status: questions.status })
      .from(questions)
      .where(eq(questions.id, ids.questionId));
    const [m] = await db
      .select({ resolved: markets.resolved })
      .from(markets)
      .where(eq(markets.id, ids.questionId));
    const [t] = await db
      .select({ isActive: timeframedMarkets.isActive })
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.id, ids.timeframedId));
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, ids.userId));
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, ids.userId));
    const proofs = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, ids.proofId));
    return {
      balance: Number(user?.virtualBalance),
      publicProofs: proofs.length,
      payouts: ledger
        .filter((row) => row.type === 'pred_resolve')
        .map((row) => Number(row.amount)),
      status: q?.status,
      paid: m?.resolved,
      timeframedActive: t?.isActive,
    };
  }

  async function runTick() {
    const { POST } = await import('@/app/api/cron/markets-recovery/route');
    const res = await POST(
      new NextRequest('http://localhost/api/cron/markets-recovery', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      })
    );
    expect(res.status).toBe(200);
    const body: {
      skipped?: boolean;
      marketsCreated?: number;
      subMarketsCreated?: number;
    } = await res.json();
    appendFileSync(receiptPath, JSON.stringify({ realTick: body }) + '\n', {
      mode: 0o600,
    });
    expect(body.skipped).not.toBe(true);
    expect(body.marketsCreated).toBe(0);
    expect(body.subMarketsCreated).toBe(0);
  }

  async function decide(fixture: Fixture, action: 'approve' | 'reject') {
    const { POST } = await import('@/app/api/admin/resolutions/[id]/route');
    const token = getAdminToken();
    if (!token) throw new Error('Integration admin token is required');
    const response = await POST(
      new NextRequest(
        `http://localhost/api/admin/resolutions/${fixture.questionId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dev-admin-token': token,
          },
          body: JSON.stringify({ action }),
        }
      ),
      { params: Promise.resolve({ id: fixture.questionId }) }
    );
    expect(response.status).toBe(200);
  }

  function heldState() {
    return {
      balance: 400,
      payouts: [],
      publicProofs: 0,
      status: 'active',
      paid: false,
      timeframedActive: true,
    };
  }
  function paidState(fixture: Fixture) {
    return {
      balance: 400 + fixture.payout,
      payouts: [fixture.payout],
      publicProofs: 1,
      status: 'resolved',
      paid: true,
      timeframedActive: false,
    };
  }

  describe('markets-tick manual resolution review', () => {
    test('funded reviews stay held across ticks until approval; rejection postpones payment', async () => {
      const pending = await seedEndedMarket('pending');
      const unset = await seedEndedMarket('unset');
      const rejected = await seedEndedMarket('rejected');
      const approved = await seedEndedMarket('approved');
      for (let i = 0; i < 2; i++) {
        await runTick();
        for (const fixture of [pending, unset, rejected])
          expect(await stateOf(fixture)).toEqual(heldState());
        expect(await stateOf(approved)).toEqual(paidState(approved));
      }
      await decide(pending, 'approve');
      await decide(unset, 'reject');
      for (let i = 0; i < 2; i++) {
        await runTick();
        for (const fixture of [unset, rejected])
          expect(await stateOf(fixture)).toEqual(heldState());
        for (const fixture of [pending, approved])
          expect(await stateOf(fixture)).toEqual(paidState(fixture));
      }
      const actual = {
        questions: await db
          .select({
            id: questions.id,
            canonical: sql<string>`to_jsonb(${questions})::text`,
          })
          .from(questions)
          .where(
            inArray(
              questions.id,
              support.questions.map((r) => r.id)
            )
          ),
        markets: await db
          .select({
            id: markets.id,
            canonical: sql<string>`to_jsonb(${markets})::text`,
          })
          .from(markets)
          .where(
            inArray(
              markets.id,
              support.markets.map((r) => r.id)
            )
          ),
        timeframed: await db
          .select({
            id: timeframedMarkets.id,
            canonical: sql<string>`to_jsonb(${timeframedMarkets})::text`,
          })
          .from(timeframedMarkets)
          .where(
            inArray(
              timeframedMarkets.id,
              support.timeframed.map((r) => r.id)
            )
          ),
      };
      const ordered = (rows: PhysicalRow[]) =>
        [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const key of ['questions', 'markets', 'timeframed'] as const)
        expect(ordered(actual[key])).toEqual(ordered(support[key]));
    });

    test('a losing admin resolver preserves the paid outcome and writes no audit', async () => {
      const fixture = await seedEndedMarket('unset');
      const marketId = fixture.questionId;
      const { POST } = await import('@/app/api/admin/markets/[marketId]/route');
      const token = getAdminToken();
      if (!token) throw new Error('Integration admin token is required');
      const ready = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const winner = withPredictionSettlement(
        marketId,
        { system: 'test_game_tick' },
        async (service, tx) => {
          const [row] = await tx
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(markets)
            .where(eq(markets.id, marketId));
          if (!row) throw new Error('Missing settlement lock holder');
          ready.resolve(row.pid);
          await release.promise;
          await service.resolve({ marketId, winningSide: 'yes' });
          await tx
            .update(questions)
            .set({ status: 'resolved', resolvedOutcome: true })
            .where(eq(questions.id, marketId));
        },
        {
          fees: {
            tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
            platformShare: FEE_CONFIG.PLATFORM_SHARE,
            referrerShare: FEE_CONFIG.REFERRER_SHARE,
            minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
          },
        }
      );
      void winner.catch(ready.reject);
      let pending: ReturnType<typeof POST> | undefined;
      let response: Response;
      try {
        const pid = await ready.promise;
        pending = POST(
          new NextRequest(`http://localhost/api/admin/markets/${marketId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dev-admin-token': token,
            },
            body: JSON.stringify({ action: 'resolve', resolution: false }),
          }),
          { params: Promise.resolve({ marketId }) }
        );
        void pending.catch(() => {});
        const deadline = Date.now() + 5000;
        while (true) {
          const waiting = await db.execute(sql`
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
            throw new Error('Admin never reached the settlement lock');
          await Bun.sleep(20);
        }
        release.resolve();
        await winner;
        response = await pending;
      } finally {
        release.resolve();
        await Promise.allSettled([winner, pending]);
      }

      const [market] = await db
        .select({ resolved: markets.resolved, resolution: markets.resolution })
        .from(markets)
        .where(eq(markets.id, marketId));
      expect(market).toEqual({ resolved: true, resolution: true });
      const [question] = await db
        .select({
          status: questions.status,
          outcome: questions.resolvedOutcome,
          reviewer: questions.resolutionReviewedBy,
        })
        .from(questions)
        .where(eq(questions.id, marketId));
      expect(question).toEqual({
        status: 'resolved',
        outcome: true,
        reviewer: null,
      });
      expect((await stateOf(fixture)).payouts).toEqual([fixture.payout]);
      expect(response.status).toBe(409);
      expect(
        await db
          .select({ id: adminAuditLogs.id })
          .from(adminAuditLogs)
          .where(eq(adminAuditLogs.resourceId, marketId))
      ).toEqual([]);
    });
  });
}
