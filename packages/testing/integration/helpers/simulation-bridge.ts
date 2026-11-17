/** Own a loopback child before sending any simulator mutation requests. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const serverPath = fileURLToPath(
  new URL(
    '../../../sim/core/bridge/simulation-bridge-server.ts',
    import.meta.url
  )
);
const statsSchema = z.object({
  totalRecords: z.number(),
  sequenceId: z.number(),
});

export async function reserveBridgePort() {
  const listener = createServer();
  let connections = 0;
  listener.on('connection', (socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Expected owned loopback TCP listener');
  }
  return {
    port: address.port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function spawnBridge(port: number) {
  const token = randomUUID();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(
    [
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      serverPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--token',
      token,
    ],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        NODE_ENV: 'test',
        BUN_ENV: 'test',
        TZ: 'UTC',
        CI: 'false',
        DATABASE_URL: 'postgresql://bridge_test@127.0.0.1:1/bridge_test',
        DIRECT_DATABASE_URL: 'postgresql://bridge_test@127.0.0.1:1/bridge_test',
        DATABASE_READ_REPLICA_URL: '',
        DATABASE_POOL_MAX: '1',
        REDIS_URL: '',
        GAME_START: 'pause',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  let logs = '';
  const capture = (stream: ReadableStream<Uint8Array>) =>
    stream.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          logs = (logs + new TextDecoder().decode(chunk)).slice(-16_384);
        },
      })
    );
  const captured = Promise.all([capture(child.stdout), capture(child.stderr)]);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(5_000),
    });
  return {
    child,
    base,
    authToken: token,
    request,
    logs: () => logs,
    async ready() {
      const deadline = Date.now() + 15_000;
      const marker = `Simulation bridge server running on ${base}`;
      while (!logs.includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(
            `Owned bridge did not bind (exit ${child.exitCode}): ${logs}`
          );
        }
        await Bun.sleep(25);
      }
      if (child.exitCode !== null)
        throw new Error(`Owned bridge exited: ${logs}`);
      const response = await request('/trajectories/stats');
      if (response.status !== 200)
        throw new Error(`Owned auth probe: ${response.status}`);
      statsSchema.parse(await response.json());
      const rejectedHeaders: Record<string, string>[] = [
        {},
        { Authorization: 'Bearer invalid-owned-probe' },
      ];
      for (const headers of rejectedHeaders) {
        const refused = await fetch(`${base}/trajectories/stats`, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
        if (refused.status !== 401)
          throw new Error('Bridge token isolation failed');
        await refused.arrayBuffer();
      }
    },
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const graceful = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!graceful) child.kill('SIGKILL');
      await child.exited;
      await captured;
    },
  };
}

export async function startBridge() {
  const reservation = await reserveBridgePort();
  await reservation.close();
  const bridge = spawnBridge(reservation.port);
  try {
    await bridge.ready();
    return bridge;
  } catch (error) {
    await bridge.stop();
    throw error;
  }
}
