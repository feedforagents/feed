/**
 * Integration Tests: simulation bridge input validation.
 *
 * POST /init used to accept any numNPCs value and report success: 0,
 * negative, fractional, or non-numeric counts initialized a simulation
 * with zero NPCs, so every later call failed. GET /trajectories parsed
 * limit with parseInt, so an unreadable limit became NaN and returned an
 * empty page that a polling client cannot tell apart from "no new
 * records". Both endpoints now answer 400 instead.
 *
 * Spawns the real bridge server (no database needed for /init, /execute,
 * and /trajectories).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';

const TEST_PORT = 34600 + Math.floor(Math.random() * 100);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const BRIDGE_PATH = join(
  import.meta.dir,
  '../../../packages/sim/core/bridge/simulation-bridge-server.ts'
);

let server: ReturnType<typeof Bun.spawn> | null = null;

async function waitForHealth(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Bridge server exited early (code ${server.exitCode})`);
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

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function initOk(numNPCs: number) {
  const response = await post('/init', { numNPCs, seed: 42 });
  expect(response.status).toBe(200);
  return z
    .object({ status: z.literal('initialized'), npcIds: z.array(z.string()) })
    .parse(await response.json());
}

async function npcCount() {
  const response = await fetch(`${BASE_URL}/npcs`);
  expect(response.status).toBe(200);
  return z
    .object({ npcs: z.array(z.object({ npcId: z.string() })) })
    .parse(await response.json()).npcs.length;
}

const errorBody = z.object({ error: z.string() });
const page = z.object({
  count: z.number(),
  totalBuffered: z.number(),
  lastId: z.string(),
  serverEpoch: z.string(),
  trajectories: z.array(z.object({ id: z.string() })),
});

describe('Simulation bridge input validation', () => {
  beforeAll(async () => {
    server = Bun.spawn(['bun', BRIDGE_PATH, '--port', String(TEST_PORT)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForHealth();
  });

  afterAll(async () => {
    if (server) {
      server.kill();
      await server.exited;
      server = null;
    }
  });

  test('rejects a non-positive, fractional, or non-numeric numNPCs with 400', async () => {
    for (const numNPCs of [0, -5, 2.5, 'five']) {
      const response = await post('/init', { numNPCs, seed: 42 });
      expect(response.status).toBe(400);
      expect(errorBody.parse(await response.json()).error).toContain('numNPCs');
    }
  });

  test('rejects a numNPCs above the cap with 400', async () => {
    const response = await post('/init', { numNPCs: 10_001, seed: 42 });
    expect(response.status).toBe(400);
    expect(errorBody.parse(await response.json()).error).toContain('numNPCs');
  });

  test('keeps the previous simulation after a rejected /init', async () => {
    const before = await initOk(2);
    expect(before.npcIds).toHaveLength(2);
    const rejected = await post('/init', { numNPCs: 0, seed: 42 });
    expect(rejected.status).toBe(400);
    await rejected.arrayBuffer();
    expect(await npcCount()).toBe(2);
  });

  test('accepts a valid numNPCs at the cap boundary', async () => {
    const ok = await initOk(10_000);
    expect(ok.npcIds).toHaveLength(10_000);
    expect(await npcCount()).toBe(10_000);
  });

  test('rejects a non-integer or non-positive trajectories limit with 400', async () => {
    await initOk(2);
    const executed = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'wait' },
    });
    expect(executed.status).toBe(200);
    await executed.arrayBuffer();
    for (const limit of ['abc', '-5', '0', '1.5', '10abc']) {
      const response = await fetch(
        `${BASE_URL}/trajectories?limit=${encodeURIComponent(limit)}`
      );
      expect(response.status).toBe(400);
      expect(errorBody.parse(await response.json()).error).toContain('limit');
    }
  });

  test('returns buffered trajectories for a valid limit', async () => {
    await initOk(2);
    // The fork base predates the clear-on-/init fix, so earlier tests may
    // have left records behind. Cursor from the current end instead of
    // assuming an empty buffer.
    const beforeResponse = await fetch(`${BASE_URL}/trajectories?limit=1000`);
    expect(beforeResponse.status).toBe(200);
    const beforePage = page.parse(await beforeResponse.json());
    const executed = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'wait' },
    });
    expect(executed.status).toBe(200);
    await executed.arrayBuffer();
    const response = await fetch(
      `${BASE_URL}/trajectories?since_id=${encodeURIComponent(beforePage.lastId)}&limit=1`
    );
    expect(response.status).toBe(200);
    const result = page.parse(await response.json());
    expect(result.count).toBe(1);
    expect(result.totalBuffered).toBe(beforePage.totalBuffered + 1);
  });
});
