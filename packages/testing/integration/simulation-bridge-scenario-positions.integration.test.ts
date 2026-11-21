import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { db, inArray, markets, perpPositions, positions } from '@feed/db';

/**
 * Simulation bridge: scenario positions must be current holdings only.
 *
 * Regression test: getPositionsForUser returned every position row for the
 * NPC, including perp positions already closed (closedAt set, size retained)
 * and prediction positions already resolved or closed (shares retained on
 * resolved rows, final PnL relabelled as unrealizedPnL). The scenario told
 * trainers the NPC still held positions it no longer held.
 *
 * Requires a database (DATABASE_URL) and spawns the real bridge server.
 * Run: DATABASE_URL=<redacted>
 *   bun test packages/testing/integration/simulation-bridge-scenario-positions.integration.test.ts
 */

const TEST_PORT = 34601;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const BRIDGE_PATH = join(
  import.meta.dir,
  '../../../packages/sim/core/bridge/simulation-bridge-server.ts'
);

const prefix = `bridge-positions-${crypto.randomUUID()}`;
const marketId = `${prefix}-m`;
const perpIds: string[] = [];
const positionIds: string[] = [];

let server: ReturnType<typeof Bun.spawn> | null = null;

async function readStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
): Promise<string> {
  if (!(stream instanceof ReadableStream)) return '';
  return new Response(stream).text();
}

async function waitForHealth(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr = await readStream(child.stderr);
      const stdout = await readStream(child.stdout);
      throw new Error(
        `Bridge server exited early (code ${child.exitCode})\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`
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
  const now = new Date();
  await db.insert(markets).values({
    id: marketId,
    question: `Will the bridge positions test market resolve yes?`,
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    createdAt: now,
    updatedAt: now,
  });

  // Closed perp: closedAt set, size retained on the row.
  const closedPerpId = `${prefix}-perp-closed`;
  perpIds.push(closedPerpId);
  await db.insert(perpPositions).values({
    id: closedPerpId,
    userId: 'npc-000',
    ticker: 'NVDA',
    organizationId: 'nvidia',
    side: 'long',
    entryPrice: 100,
    currentPrice: 110,
    size: 100,
    leverage: 5,
    liquidationPrice: 80,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    fundingPaid: 0,
    openedAt: now,
    lastUpdated: now,
    closedAt: now,
    realizedPnL: 10,
  });

  // Open perp: still held.
  const openPerpId = `${prefix}-perp-open`;
  perpIds.push(openPerpId);
  await db.insert(perpPositions).values({
    id: openPerpId,
    userId: 'npc-000',
    ticker: 'NVDA',
    organizationId: 'nvidia',
    side: 'short',
    entryPrice: 100,
    currentPrice: 95,
    size: 50,
    leverage: 5,
    liquidationPrice: 120,
    unrealizedPnL: 2.5,
    unrealizedPnLPercent: 5,
    fundingPaid: 0,
    openedAt: now,
    lastUpdated: now,
    closedAt: null,
    realizedPnL: null,
  });

  // Resolved prediction position: shares retained, status resolved.
  const resolvedPosId = `${prefix}-pos-resolved`;
  positionIds.push(resolvedPosId);
  await db.insert(positions).values({
    id: resolvedPosId,
    userId: 'npc-000',
    marketId,
    side: true,
    shares: '10',
    avgPrice: '0.5',
    cashCostBasis: '5',
    status: 'resolved',
    outcome: true,
    pnl: '5',
    createdAt: now,
    updatedAt: now,
  });

  // Closed prediction position: no shares left, status closed.
  const closedPosId = `${prefix}-pos-closed`;
  positionIds.push(closedPosId);
  await db.insert(positions).values({
    id: closedPosId,
    userId: 'npc-000',
    marketId,
    side: false,
    shares: '0',
    avgPrice: '0.4',
    cashCostBasis: '0',
    status: 'closed',
    outcome: null,
    pnl: '1',
    createdAt: now,
    updatedAt: now,
  });

  // Active prediction position: still held.
  const activePosId = `${prefix}-pos-active`;
  positionIds.push(activePosId);
  await db.insert(positions).values({
    id: activePosId,
    userId: 'npc-000',
    marketId,
    side: true,
    shares: '5',
    avgPrice: '0.5',
    cashCostBasis: '2.5',
    status: 'active',
    outcome: null,
    pnl: '0',
    createdAt: now,
    updatedAt: now,
  });

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
  if (positionIds.length) {
    await db.delete(positions).where(inArray(positions.id, positionIds));
  }
  if (perpIds.length) {
    await db.delete(perpPositions).where(inArray(perpPositions.id, perpIds));
  }
  await db.delete(markets).where(inArray(markets.id, [marketId]));
  await db.$disconnect?.();
});

describe('simulation bridge scenario positions', () => {
  test('lists only open holdings, not closed or resolved positions', async () => {
    const res = await fetch(`${BASE_URL}/scenario/npc-000`);
    expect(res.ok).toBe(true);
    const scenario = (await res.json()) as {
      positions: Array<{
        id: string;
        marketType: 'prediction' | 'perp';
        marketId?: string;
        ticker?: string;
        side: string;
        size: number;
        unrealizedPnL: number;
      }>;
    };
    const byId = new Map(scenario.positions.map((p) => [p.id, p]));

    // Open holdings are present.
    expect(byId.get(`${prefix}-perp-open`)).toBeDefined();
    expect(byId.get(`${prefix}-perp-open`)?.marketType).toBe('perp');
    expect(byId.get(`${prefix}-perp-open`)?.size).toBe(50);
    expect(byId.get(`${prefix}-pos-active`)).toBeDefined();
    expect(byId.get(`${prefix}-pos-active`)?.marketType).toBe('prediction');
    expect(byId.get(`${prefix}-pos-active`)?.size).toBe(5);

    // Closed/resolved rows must not be reported as holdings.
    expect(byId.get(`${prefix}-perp-closed`)).toBeUndefined();
    expect(byId.get(`${prefix}-pos-resolved`)).toBeUndefined();
    expect(byId.get(`${prefix}-pos-closed`)).toBeUndefined();
  });
});
