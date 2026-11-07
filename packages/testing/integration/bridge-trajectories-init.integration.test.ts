/**
 * POST /init must clear the trajectory buffer.
 *
 * The bridge serves one training run per /init call: the /init seed makes
 * runs reproducible, and the Python client polls /trajectories from the
 * start of its run. A second /init with a new seed must not serve the
 * previous run's trajectories, or run 2 trains on run 1 data.
 */

import { describe, expect, it } from 'bun:test';

const PORT = 32000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = new URL(
  '../../../packages/sim/core/bridge/simulation-bridge-server.ts',
  import.meta.url
).pathname;

let proc: Bun.Subprocess | null = null;

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Server is not up yet.
    }
    if (Date.now() > deadline) throw new Error('bridge server did not start');
    await Bun.sleep(200);
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res;
}

async function getTrajectories(): Promise<{
  count: number;
  totalBuffered: number;
  trajectories: Array<{ id: string }>;
}> {
  const res = await fetch(`${BASE}/trajectories`);
  if (!res.ok) throw new Error(`/trajectories failed: ${res.status}`);
  return (await res.json()) as {
    count: number;
    totalBuffered: number;
    trajectories: Array<{ id: string }>;
  };
}

describe('bridge /init clears the trajectory buffer', () => {
  it('serves no stale trajectories after re-init with a new seed', async () => {
    // Start the bridge in-process: it takes several seconds to import the
    // engine, so the spawn and the health wait live in the test body where
    // the timeout can cover them.
    proc = Bun.spawn(['bun', 'run', SERVER_PATH], {
      env: { ...process.env, SIMULATION_BRIDGE_PORT: String(PORT) },
      stderr: 'ignore',
      stdout: 'ignore',
    });
    try {
      await waitForHealth();
      await post('/init', { numNPCs: 3, seed: 111, syntheticMarkets: true });
      await post('/execute', { npcId: 'npc-000', action: { type: 'wait' } });
      await post('/execute', { npcId: 'npc-001', action: { type: 'wait' } });

      let rows = await getTrajectories();
      expect(rows.count).toBe(2);
      expect(rows.trajectories.map((t) => t.id)).toEqual(['traj-1', 'traj-2']);

      await post('/init', { numNPCs: 3, seed: 222, syntheticMarkets: true });

      rows = await getTrajectories();
      expect(rows.count).toBe(0);
      expect(rows.totalBuffered).toBe(0);

      await post('/execute', { npcId: 'npc-000', action: { type: 'wait' } });
      rows = await getTrajectories();
      expect(rows.count).toBe(1);
      expect(rows.trajectories[0].id).toBe('traj-1');
    } finally {
      proc?.kill();
      proc = null;
    }
  }, 30_000);
});
