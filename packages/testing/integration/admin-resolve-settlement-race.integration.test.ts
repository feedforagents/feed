/**
 * Admin resolve must not rewrite a market another resolver settled first.
 *
 * PRD §9.2 (show the resolution reason and outcome) and MVP phase 6: the
 * question shown for a market must carry the outcome the market paid. The
 * admin route checks `markets.resolved` before it takes the settlement lock.
 * When the game tick holds that lock and resolves the market first, the
 * route waits, then `service.resolve` returns without paying (correct), but
 * the route still wrote its own outcome to the question, audited a
 * resolution and answered 200.
 *
 * Real route handler, real settlement wrapper and service, real Postgres.
 * The "tick" is a real `withPredictionSettlement` transaction that holds the
 * lock until the admin request is waiting on it. Only admin authentication,
 * the rate limiter and the audit write are replaced.
 */

import { afterAll, expect, it, mock } from 'bun:test';
import * as actualApi from '@feed/api';
import {
  db,
  eq,
  inArray,
  markets,
  questions,
  sql,
  timeframedMarkets,
} from '@feed/db';
import { FEE_CONFIG, withPredictionSettlement } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

mock.module('server-only', () => ({}));

const audits: unknown[] = [];
mock.module('@feed/api', () => ({
  ...actualApi,
  requireAdmin: async () => ({ userId: 'admin-resolve-race' }),
  checkRateLimitAndDuplicates: () => null,
  logAdminModify: async (entry: unknown) => {
    audits.push(entry);
  },
}));

const { POST } = await import(
  '../../../apps/web/src/app/api/admin/markets/[marketId]/route'
);

const createdMarketIds: string[] = [];
const options = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};

async function createMarketWithQuestion(): Promise<string> {
  const marketId = await generateSnowflakeId();
  const now = new Date();
  const [row] = (await db.execute(
    sql`SELECT COALESCE(MAX("questionNumber"), 0) + 1 AS next FROM "Question"`
  )) as unknown as Array<{ next: number }>;
  if (!row) throw new Error('Question number query returned no row');
  await db.insert(markets).values({
    id: marketId,
    question: 'Admin resolve settlement race',
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: new Date(now.getTime() + 86_400_000),
    updatedAt: now,
  });
  createdMarketIds.push(marketId);
  await db.insert(questions).values({
    id: marketId,
    questionNumber: Number(row.next),
    text: 'Admin resolve settlement race',
    scenarioId: 1,
    outcome: true,
    rank: 1,
    resolutionDate: new Date(now.getTime() + 86_400_000),
    status: 'active',
    updatedAt: now,
  });
  return marketId;
}

/** True once a backend waits on the market's settlement advisory lock. */
async function adminIsWaitingOnLock(): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
  )) as unknown as unknown[];
  return rows.length > 0;
}

it('answers 409 and leaves the question alone when the tick resolved first', async () => {
  const marketId = await createMarketWithQuestion();

  let releaseTick!: () => void;
  const tickMayResolve = new Promise<void>((resolve) => {
    releaseTick = resolve;
  });
  let tickHasLock!: () => void;
  const tickLocked = new Promise<void>((resolve) => {
    tickHasLock = resolve;
  });

  // The game tick takes the settlement lock and resolves YES.
  const tick = withPredictionSettlement(
    marketId,
    { system: 'test_game_tick' },
    async (service, tx) => {
      tickHasLock();
      await tickMayResolve;
      await service.resolve({ marketId, winningSide: 'yes' });
      await tx
        .update(questions)
        .set({
          status: 'resolved',
          resolvedOutcome: true,
          updatedAt: new Date(),
        })
        .where(eq(questions.id, marketId));
    },
    options
  );
  await tickLocked;

  // The admin resolves NO; its pre-check still sees an unresolved market.
  const admin = POST(
    new Request(`http://localhost/api/admin/markets/${marketId}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', resolution: false }),
    }) as never,
    { params: Promise.resolve({ marketId }) }
  ) as Promise<Response>;

  const deadline = Date.now() + 10_000;
  while (!(await adminIsWaitingOnLock())) {
    if (Date.now() > deadline) throw new Error('admin never reached the lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releaseTick();
  await tick;
  const response = await admin;

  const [market] = await db
    .select({ resolved: markets.resolved, resolution: markets.resolution })
    .from(markets)
    .where(eq(markets.id, marketId));
  expect(market).toEqual({ resolved: true, resolution: true });

  const [question] = await db
    .select({
      status: questions.status,
      resolvedOutcome: questions.resolvedOutcome,
      resolutionReviewedBy: questions.resolutionReviewedBy,
    })
    .from(questions)
    .where(eq(questions.id, marketId));
  expect(question).toEqual({
    status: 'resolved',
    resolvedOutcome: true,
    resolutionReviewedBy: null,
  });

  expect(response.status).toBe(409);
  expect(audits).toHaveLength(0);
});

afterAll(async () => {
  if (!createdMarketIds.length) return;
  await db
    .delete(timeframedMarkets)
    .where(inArray(timeframedMarkets.questionId, createdMarketIds));
  await db.delete(questions).where(inArray(questions.id, createdMarketIds));
  await db.delete(markets).where(inArray(markets.id, createdMarketIds));
});
