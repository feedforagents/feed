/**
 * GET /api/questions/[id]/dynamics against a real database: the route
 * reports the market's totalVolume (sum over the market's positions of
 * shares × avgPrice) and totalPositions as the market's totals — the same
 * definition the admin trading stats compute with an uncapped SQL SUM
 * over every position row.
 *
 * The route loads only the most recent 1,000 position rows and computes
 * both totals from that sample, so on a market with more than 1,000
 * positions the reported totalVolume understates the positions ledger
 * and totalPositions reads 1,000 instead of the real count.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and real trades through
 * PredictionMarketService — 1,005 distinct buyers on the busy market, so
 * the position rows are exactly the rows the service writes. The expected
 * totals are read back from the full positions ledger.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  db,
  eq,
  inArray,
  markets,
  positions,
  questions,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';

type DynamicsResponse = {
  totalVolume: number;
  totalPositions: number;
};

let dynamicsGET: typeof import('../../../apps/web/src/app/api/questions/[id]/dynamics/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const busyId = `f142-dyn-busy-${suffix}`;
const quietId = `f142-dyn-quiet-${suffix}`;
const questionIds = [busyId, quietId];
const BUSY_BUYERS = 1005;
const QUIET_BUYERS = 3;
const buyerIds: string[] = [];
for (let i = 0; i < BUSY_BUYERS + QUIET_BUYERS; i++) {
  buyerIds.push(`f142-dyn-user-${i}-${suffix}`);
}
// Route validates the path id as 1–9 digits.
let questionNumber = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const numberByQuestion = new Map<string, number>();

async function fetchDynamics(questionId: string) {
  const num = numberByQuestion.get(questionId);
  if (num === undefined)
    throw new Error(`no question number for ${questionId}`);
  const response = await dynamicsGET(
    new NextRequest(`http://localhost/api/questions/${num}/dynamics`),
    { params: Promise.resolve({ id: String(num) }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DynamicsResponse;
}

/** Ledger totals exactly as the route defines them — over ALL rows. */
async function ledgerTotals(marketId: string) {
  const rows = await db
    .select({ shares: positions.shares, avgPrice: positions.avgPrice })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  return {
    count: rows.length,
    volume: rows.reduce(
      (sum, p) => sum + Number(p.shares) * Number(p.avgPrice),
      0
    ),
  };
}

async function createMarket(id: string, liquidity: number): Promise<void> {
  const num = questionNumber++;
  numberByQuestion.set(id, num);
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: num,
      text: `Dynamics total volume fixture ${id}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 7 * 86400000),
      status: 'active',
      updatedAt: new Date(),
    })
    .returning();
  if (!question) throw new Error(`question insert failed for ${id}`);
  await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    liquidity,
    { initialYesProbability: 0.5 }
  );
}

function makeService(): PredictionMarketService {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => 1_000_000,
    },
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.7,
      referrerShare: 0.3,
      minFeeAmount: 0.01,
    },
  });
}

beforeAll(async () => {
  ({ GET: dynamicsGET } = await import(
    '../../../apps/web/src/app/api/questions/[id]/dynamics/route'
  ));

  // Buyers (fixture users; the positions themselves are written by the
  // real service buy path, one row per distinct buyer).
  for (let i = 0; i < buyerIds.length; i += 250) {
    const chunk = buyerIds.slice(i, i + 250);
    await db.insert(users).values(
      chunk.map((id, j) => ({
        id,
        username: `f142dyn-${i + j}-${suffix}`,
        displayName: 'Dynamics Volume Fixture User',
        updatedAt: new Date(),
      }))
    );
  }

  await createMarket(busyId, 20000);
  await createMarket(quietId, 4000);

  const service = makeService();
  // Busy market: 1,005 small real buys — past the route's 1,000-row
  // sample. Every buy is the same size, so whichever rows the sample
  // drops, the dropped volume is the same.
  for (let i = 0; i < BUSY_BUYERS; i++) {
    await service.buy({
      marketId: busyId,
      userId: buyerIds[i],
      amount: 10,
      side: 'yes',
    });
  }
  // Quiet control market: a few buys, well under the sample size.
  for (let i = 0; i < QUIET_BUYERS; i++) {
    await service.buy({
      marketId: quietId,
      userId: buyerIds[BUSY_BUYERS + i],
      amount: 10,
      side: 'yes',
    });
  }
}, 600_000);

afterAll(async () => {
  await db
    .delete(positions)
    .where(inArray(positions.marketId, questionIds))
    .catch(() => {});
  await db
    .delete(markets)
    .where(inArray(markets.id, questionIds))
    .catch(() => {});
  await db
    .delete(questions)
    .where(inArray(questions.id, questionIds))
    .catch(() => {});
  for (let i = 0; i < buyerIds.length; i += 250) {
    await db
      .delete(users)
      .where(inArray(users.id, buyerIds.slice(i, i + 250)))
      .catch(() => {});
  }
});

describe('market dynamics totals', () => {
  it('counts every position on a market past 1,000 positions', async () => {
    const ledger = await ledgerTotals(busyId);
    expect(ledger.count).toBe(BUSY_BUYERS);
    const dynamics = await fetchDynamics(busyId);
    expect(dynamics.totalPositions).toBe(BUSY_BUYERS);
  });

  it('reports totalVolume as the full positions ledger sum past 1,000 positions', async () => {
    const ledger = await ledgerTotals(busyId);
    expect(ledger.volume).toBeGreaterThan(0);
    const dynamics = await fetchDynamics(busyId);
    expect(dynamics.totalVolume).toBeCloseTo(
      Math.round(ledger.volume * 100) / 100,
      2
    );
  });

  it('still reports exact totals on a market under the sample size', async () => {
    const ledger = await ledgerTotals(quietId);
    expect(ledger.count).toBe(QUIET_BUYERS);
    const dynamics = await fetchDynamics(quietId);
    expect(dynamics.totalPositions).toBe(QUIET_BUYERS);
    expect(dynamics.totalVolume).toBeCloseTo(
      Math.round(ledger.volume * 100) / 100,
      2
    );
  });
});
