/**
 * Integration Tests: simulation bridge /execute balance accounting
 *
 * Spawns the bridge server (no DB needed for /init + /execute) and checks
 * that selling a prediction position returns the principal plus the
 * simulated PnL, like the close legs do — instead of debiting the balance
 * a second time as if the sell were another buy.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

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
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `POST ${path} failed (${res.status}): ${JSON.stringify(json)}`
    );
  }
  return json;
}

describe('Simulation bridge /execute sell legs', () => {
  beforeAll(async () => {
    server = Bun.spawn(['bun', BRIDGE_PATH, '--port', String(TEST_PORT)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForHealth();
    await post('/init', { numNPCs: 2, seed: 42 });
  });

  afterAll(async () => {
    if (server) {
      server.kill();
      await server.exited;
      server = null;
    }
  });

  test('sell_yes returns the principal instead of debiting it again', async () => {
    const bought = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'buy_yes', amount: 100 },
    });
    expect(bought.success).toBe(true);
    expect(bought.newBalance).toBe(9900);

    const sold = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'sell_yes', amount: 100 },
    });
    expect(sold.success).toBe(true);
    // A sell exits the position: principal comes back plus the simulated
    // PnL ((random() - 0.4) * 100 * 0.2, i.e. within [-8, +12]), so the
    // balance lands in [9992, 10012).
    // Before the fix the sell debited the balance a second time (9800).
    expect(Number(sold.newBalance)).toBeGreaterThan(9800);
    expect(Number(sold.newBalance)).toBeGreaterThanOrEqual(9992);
    expect(Number(sold.newBalance)).toBeLessThanOrEqual(10012);
  });

  test('sell_no returns the principal instead of debiting it again', async () => {
    const bought = await post('/execute', {
      npcId: 'npc-001',
      action: { type: 'buy_no', amount: 100 },
    });
    expect(bought.success).toBe(true);
    expect(bought.newBalance).toBe(9900);

    const sold = await post('/execute', {
      npcId: 'npc-001',
      action: { type: 'sell_no', amount: 100 },
    });
    expect(sold.success).toBe(true);
    expect(Number(sold.newBalance)).toBeGreaterThan(9800);
    expect(Number(sold.newBalance)).toBeGreaterThanOrEqual(9992);
    expect(Number(sold.newBalance)).toBeLessThanOrEqual(10012);
  });
});
