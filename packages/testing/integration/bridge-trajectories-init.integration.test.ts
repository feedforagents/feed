/** PRD §13/D-24, MVP Phase0 step5: isolated simulator run boundaries. */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  reserveBridgePort,
  spawnBridge,
  startBridge,
} from './helpers/simulation-bridge';

const trajectory = z.object({
  id: z.string(),
  npcId: z.string(),
  reasoning: z.string().optional(),
});
const page = z.object({
  count: z.number(),
  totalBuffered: z.number(),
  lastId: z.string(),
  serverEpoch: z.string(),
  trajectories: z.array(trajectory),
});
type Bridge = Awaited<ReturnType<typeof startBridge>>;
async function post(
  bridge: Bridge,
  path: string,
  body: Record<string, string | number | boolean | Record<string, string>>
) {
  const response = await bridge.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response;
}
async function init(bridge: Bridge, seed: number) {
  const result = z
    .object({
      status: z.literal('initialized'),
      seed: z.number(),
      syntheticMarkets: z.boolean(),
    })
    .parse(
      await (
        await post(bridge, '/init', {
          numNPCs: 3,
          seed,
          syntheticMarkets: true,
        })
      ).json()
    );
  expect(result.seed).toBe(seed);
  expect(result.syntheticMarkets).toBe(true);
}
async function act(bridge: Bridge, reasoning: string) {
  const result = z
    .object({ success: z.boolean(), newBalance: z.number() })
    .parse(
      await (
        await post(bridge, '/execute', {
          npcId: 'npc-000',
          action: { type: 'wait' },
          reasoning,
        })
      ).json()
    );
  expect(result.success).toBe(true);
  expect(result.newBalance).toBe(10_000);
}
async function records(bridge: Bridge, since = '') {
  const response = await bridge.request(
    `/trajectories?since_id=${encodeURIComponent(since)}`
  );
  expect(response.status).toBe(200);
  return page.parse(await response.json());
}

describe('bridge /init clears records while retaining cursor continuity', () => {
  it('starts a fresh buffer with unique IDs in the same server epoch', async () => {
    const bridge = await startBridge();
    try {
      await init(bridge, 111);
      await act(bridge, 'run-one-a');
      await act(bridge, 'run-one-b');
      const first = await records(bridge);
      expect(first.trajectories.map((row) => row.id)).toEqual([
        'traj-1',
        'traj-2',
      ]);
      await init(bridge, 222);
      const empty = await records(bridge);
      expect(empty.count).toBe(0);
      expect(empty.totalBuffered).toBe(0);
      expect(empty.serverEpoch).toBe(first.serverEpoch);
      await act(bridge, 'run-two-a');
      const second = await records(bridge);
      expect(second.count).toBe(1);
      expect(second.trajectories.map((row) => row.id)).toEqual(['traj-3']);
      expect(second.trajectories.map((row) => row.reasoning)).toEqual([
        'run-two-a',
      ]);
    } finally {
      await bridge.stop();
    }
  }, 25_000);

  it('retains every run-two record when polling with a run-one cursor', async () => {
    const bridge = await startBridge();
    try {
      await init(bridge, 111);
      for (let i = 0; i < 3; i++) await act(bridge, `run-one-${i}`);
      const first = await records(bridge);
      expect(first.lastId).toBe('traj-3');
      await init(bridge, 222);
      for (let i = 0; i < 3; i++) await act(bridge, `run-two-${i}`);
      const second = await records(bridge, first.lastId);
      expect(second.serverEpoch).toBe(first.serverEpoch);
      expect(second.trajectories.map((row) => row.id)).toEqual([
        'traj-4',
        'traj-5',
        'traj-6',
      ]);
      expect(second.trajectories.map((row) => row.reasoning)).toEqual([
        'run-two-0',
        'run-two-1',
        'run-two-2',
      ]);
      const tail = await records(bridge, second.lastId);
      expect(tail.count).toBe(0);
    } finally {
      await bridge.stop();
    }
  }, 25_000);

  it('continues an already-open SSE stream across re-init', async () => {
    const bridge = await startBridge();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await init(bridge, 111);
      await act(bridge, 'run-one-before-stream');
      const response = bridge.request('/trajectories/stream', {
        signal: controller.signal,
      });
      await Bun.sleep(100);
      await act(bridge, 'run-one-stream-control');
      const stream = await response;
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      if (!stream.body) throw new Error('Missing SSE body');
      reader = stream.body.getReader();
      let buffered = '';
      const read = async () => {
        const deadline = Date.now() + 3_000;
        while (!buffered.includes('\n\n')) {
          const pending = reader?.read();
          if (!pending) throw new Error('Missing owned SSE reader');
          const next = await Promise.race([
            pending,
            Bun.sleep(Math.max(1, deadline - Date.now())).then(() => {
              throw new Error('SSE record timeout');
            }),
          ]);
          if (next.done) throw new Error('SSE ended before record');
          buffered += new TextDecoder().decode(next.value);
        }
        const end = buffered.indexOf('\n\n');
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (!event.startsWith('data: '))
          throw new Error('Unexpected SSE frame');
        return trajectory.parse(JSON.parse(event.slice(6)));
      };
      expect((await read()).id).toBe('traj-2');
      const cursor = (await records(bridge)).lastId;
      expect(cursor).toBe('traj-2');
      await init(bridge, 222);
      await act(bridge, 'run-two-stream-a');
      await act(bridge, 'run-two-stream-b');
      const observed = [await read(), await read()];
      expect(observed.map((row) => row.id)).toEqual(['traj-3', 'traj-4']);
      expect(observed.map((row) => row.reasoning)).toEqual([
        'run-two-stream-a',
        'run-two-stream-b',
      ]);
    } finally {
      try {
        if (reader) await reader.cancel();
      } finally {
        controller.abort();
        await bridge.stop();
      }
    }
  }, 30_000);

  it('refuses an occupied port without sending requests to its listener', async () => {
    const reservation = await reserveBridgePort();
    const bridge = spawnBridge(reservation.port);
    try {
      const exit = await Promise.race([
        bridge.child.exited,
        Bun.sleep(15_000).then(() => {
          throw new Error('Occupied-port child failed to exit');
        }),
      ]);
      expect(exit).not.toBe(0);
      expect(bridge.logs()).not.toContain(
        `Simulation bridge server running on ${bridge.base}`
      );
      expect(bridge.logs()).toMatch(/EADDRINUSE|already in use/);
      expect(reservation.connections()).toBe(0);
    } finally {
      await bridge.stop();
      await reservation.close();
    }
  }, 25_000);
});
