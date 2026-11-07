import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * End-to-end tests for the simulation bridge server (packages/sim/core/bridge).
 * The server is spawned as a subprocess on a test port so the tests exercise
 * the real HTTP contract the Python RL training client uses.
 *
 * Closing a perp position must only return the staked amount plus PnL when
 * the NPC actually holds an open position of that size. Before the fix, a
 * close of any amount succeeded and credited amount + PnL even with no open
 * position, minting funds out of nothing (10,000 -> 1,050,220.75 on a
 * close_long of 1,000,000 with no prior open).
 */

const PORT = 32123;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Server not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error('Bridge server did not become healthy in time');
    }
    await Bun.sleep(200);
  }
}

async function post(
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function getBalance(npcId: string): Promise<number> {
  const res = await fetch(`${BASE}/npcs`);
  const data = (await res.json()) as {
    npcs: { npcId: string; balance: number }[];
  };
  const npc = data.npcs.find((n) => n.npcId === npcId);
  if (!npc) throw new Error(`NPC ${npcId} not found`);
  return npc.balance;
}

describe('simulation bridge server /execute close', () => {
  beforeAll(async () => {
    const serverPath = join(
      import.meta.dir,
      '..',
      'core',
      'bridge',
      'simulation-bridge-server.ts'
    );
    proc = Bun.spawn(['bun', 'run', serverPath], {
      env: { ...process.env, SIMULATION_BRIDGE_PORT: String(PORT) },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await waitForHealth();
    await post('/init', { numNPCs: 1, seed: 42 });
  });

  afterAll(() => {
    proc?.kill();
    proc = null;
  });

  it('rejects a close with no open position and leaves the balance unchanged', async () => {
    const before = await getBalance('npc-000');
    expect(before).toBe(10_000);

    const outcome = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'close_long', amount: 1_000_000 },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(await getBalance('npc-000')).toBe(before);
  });

  it('rejects a close larger than the open position', async () => {
    const open = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'open_long', amount: 100 },
    });
    expect(open.success).toBe(true);
    expect(await getBalance('npc-000')).toBe(9_900);

    const outcome = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'close_long', amount: 200 },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(await getBalance('npc-000')).toBe(9_900);
  });

  it('credits a close up to the open position size', async () => {
    const outcome = await post('/execute', {
      npcId: 'npc-000',
      action: { type: 'close_long', amount: 100 },
    });

    expect(outcome.success).toBe(true);
    // Close returns the 100 stake plus PnL in [-8, +12] for amount 100.
    const balance = await getBalance('npc-000');
    expect(balance).toBeGreaterThanOrEqual(9_992);
    expect(balance).toBeLessThanOrEqual(10_012);
  });
});
