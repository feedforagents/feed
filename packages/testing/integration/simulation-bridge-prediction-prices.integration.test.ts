import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { db, inArray, markets, questions } from '@feed/db';

/**
 * Simulation bridge: DB prediction markets must report the CPMM price.
 *
 * Regression test: getPredictionMarketsData used to read `yesPrice` /
 * `currentYesPrice` off the Question row, but the Question table has neither
 * column, so every DB market reported yesPrice 50 / noPrice 50 no matter how
 * much trading had moved the pool. The live price lives in the linked
 * Market row (yesShares / noShares) under the CPMM definition
 * (PredictionPricing.getCurrentPrice), on the same 0-100 scale the synthetic
 * markets use.
 *
 * Requires a database (DATABASE_URL) and spawns the real bridge server.
 * Run: DATABASE_URL=... bun test packages/testing/integration/simulation-bridge-prediction-prices.integration.test.ts
 */

const TEST_PORT = 34599;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const BRIDGE_PATH = join(
  import.meta.dir,
  '../../../packages/sim/core/bridge/simulation-bridge-server.ts'
);

const prefix = `bridge-prices-${crypto.randomUUID()}`;
const marketIds: string[] = [];
const questionIds: string[] = [];
let questionNumber = 1_800_000_000 + Math.floor(Math.random() * 100_000_000);

let server: ReturnType<typeof Bun.spawn> | null = null;

async function createMarket(
  suffix: string,
  yesShares: string,
  noShares: string
) {
  const id = `${prefix}-m-${suffix}`;
  marketIds.push(id);
  const now = new Date();
  await db.insert(markets).values({
    id,
    question: `Will the bridge price test market ${suffix} resolve yes?`,
    yesShares,
    noShares,
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createQuestion(suffix: string, marketId: string | null) {
  const id = `${prefix}-q-${suffix}`;
  questionIds.push(id);
  const now = new Date();
  await db.insert(questions).values({
    id,
    questionNumber: questionNumber++,
    marketId,
    text: `Will the bridge price test question ${suffix} resolve yes?`,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    resolutionDate: new Date(Date.now() + 86400000),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function waitForHealth(
  server: ReturnType<typeof Bun.spawn>,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      const stderr = await new Response(server.stderr).text();
      const stdout = await new Response(server.stdout).text();
      throw new Error(
        `Bridge server exited early (code ${server.exitCode})\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`
      );
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Bridge server did not become healthy: ${String(lastError)}`);
}

beforeAll(async () => {
  // yesShares 3000 / noShares 7000 -> CPMM yes price 70, no price 30.
  const marketA = await createMarket('a', '3000', '7000');
  // yesShares 9000 / noShares 1000 -> CPMM yes price 10, no price 90.
  const marketB = await createMarket('b', '9000', '1000');
  await createQuestion('a', marketA);
  await createQuestion('b', marketB);
  // No linked market: no pool to price from, stays at the 50/50 default.
  await createQuestion('unlinked', null);

  server = Bun.spawn(
    [
      'bun',
      'run',
      BRIDGE_PATH,
      '--port',
      String(TEST_PORT),
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  await waitForHealth(server);

  const initRes = await fetch(`${BASE_URL}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numNPCs: 1, seed: 42 }),
  });
  expect(initRes.ok).toBe(true);
}, 90000);

afterAll(async () => {
  if (server) {
    server.kill();
    await server.exited;
    server = null;
  }
  if (questionIds.length) {
    await db.delete(questions).where(inArray(questions.id, questionIds));
  }
  if (marketIds.length) {
    await db.delete(markets).where(inArray(markets.id, marketIds));
  }
  await db.$disconnect?.();
});

describe('simulation bridge DB prediction market prices', () => {
  test('reports the CPMM price from the linked Market pool, not 50/50', async () => {
    const res = await fetch(`${BASE_URL}/scenario/npc-000`);
    expect(res.ok).toBe(true);
    const scenario = (await res.json()) as {
      marketState: {
        marketSource: string;
        predictionMarkets: Array<{
          id: string;
          question: string;
          yesPrice: number;
          noPrice: number;
        }>;
      };
    };
    expect(scenario.marketState.marketSource).toBe('database');
    const byId = new Map(
      scenario.marketState.predictionMarkets.map((m) => [m.id, m])
    );

    const marketA = byId.get(`${prefix}-q-a`);
    expect(marketA).toBeDefined();
    expect(marketA!.yesPrice).toBeCloseTo(70, 6);
    expect(marketA!.noPrice).toBeCloseTo(30, 6);

    const marketB = byId.get(`${prefix}-q-b`);
    expect(marketB).toBeDefined();
    expect(marketB!.yesPrice).toBeCloseTo(10, 6);
    expect(marketB!.noPrice).toBeCloseTo(90, 6);

    const unlinked = byId.get(`${prefix}-q-unlinked`);
    expect(unlinked).toBeDefined();
    expect(unlinked!.yesPrice).toBe(50);
    expect(unlinked!.noPrice).toBe(50);
  });
});
