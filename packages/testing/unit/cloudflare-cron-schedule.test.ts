import { describe, expect, spyOn, test } from 'bun:test';
import {
  dueJobs,
  isCronJob,
  jobs,
  localnetJobs,
} from '../../../workers/cron/src/schedule';

// The Worker entry uses Cloudflare runtime types this package does not load, so
// it is imported by URL at run time instead of by a typed static import.
const workerUrl = new URL('../../../workers/cron/src/index.ts', import.meta.url)
  .href;
type WorkerQueue = (
  batch: unknown,
  env: unknown,
  ctx: unknown
) => Promise<void>;

const at = (time: string, localnet = false) =>
  dueJobs(Date.parse(`2026-10-10T${time}:00Z`), localnet).map(
    (job) => job.path
  );

const schedules = [...jobs, ...localnetJobs];
const appOrigin = 'https://app.example';
const sourceRoute = (path: string) =>
  new URL(
    `../../../apps/web/src/app${new URL(path, appOrigin).pathname}/route.ts`,
    import.meta.url
  );

describe('Cloudflare cron schedule', () => {
  test('minute ticks are due independently of local timezone', () => {
    expect(at('12:01')).toEqual([
      '/api/cron/game-tick',
      '/api/cron/markets-tick',
      '/api/cron/realtime-drain',
    ]);
  });
  test('daily and funding boundaries are preserved', () => {
    expect(at('00:00')).toContain('/api/cron/whitelist-topn');
    expect(at('00:01')).not.toContain('/api/cron/whitelist-topn');
    expect(at('16:00')).toContain('/api/cron/perp-funding');
    expect(at('17:00')).not.toContain('/api/cron/perp-funding');
    expect(at('06:00')).toContain('/api/cron/world-facts');
    expect(at('18:00')).toContain('/api/cron/world-facts');
  });
  test('auxiliary jobs are due on their own localnet cadence only', () => {
    const recovery = '/api/cron/markets-recovery';
    expect(at('12:05', true)).toContain(recovery);
    expect(at('12:05')).not.toContain(recovery);
    const headlines = '/api/cron/world-facts?mode=headlines';
    const groups = '/api/cron/npc-tick?mode=groups';
    expect(at('12:05', true)).toContain(headlines);
    expect(at('12:06', true)).not.toContain(headlines);
    expect(at('12:02', true)).toContain(groups);
    expect(at('12:03', true)).not.toContain(groups);
    expect(at('06:00', true)).toContain('/api/cron/world-facts');
    expect(at('06:00', true)).toContain(headlines);
    expect(at('06:00')).not.toContain(headlines);
    expect(at('06:00')).not.toContain(groups);
  });

  test.each(
    schedules.map(({ path }) => path)
  )('scheduled route %s exists', async (path) => {
    expect(await Bun.file(sourceRoute(path)).exists()).toBe(true);
  });
  test.each(
    schedules.map(({ path }) => path)
  )('scheduled route %s answers the method the worker sends', async (path) => {
    const requests: Request[] = [];
    const env = {
      APP: {
        fetch: async (request: Request) => {
          requests.push(request);
          return new Response('{}');
        },
      },
      JOBS: {},
      APP_ORIGIN: appOrigin,
      CRON_SECRET: 'secret',
      CRON_ENABLED: 'true',
      DEPLOYMENT_ENV: 'localnet',
    };
    const message = {
      body: { path, scheduledTime: 0 },
      ack: () => {},
      retry: () => {},
    };
    const worker = (await import(workerUrl)).default as {
      queue: WorkerQueue;
    };
    await worker.queue({ messages: [message] }, env, {});
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(`${appOrigin}${path}`);
    // Next.js answers 405 when the route module does not export the method.
    const source = await Bun.file(sourceRoute(path)).text();
    expect(source).toMatch(
      new RegExp(`export (const|async function) ${request?.method}\\b`)
    );
  });
  test('all migrated jobs execute in a UTC day', () => {
    const seen = new Set<string>();
    const start = Date.parse('2026-10-10T00:00:00Z');
    for (let minute = 0; minute < 1440; minute++) {
      for (const job of dueJobs(start + minute * 60_000)) seen.add(job.path);
    }
    expect(seen.size).toBe(jobs.length);
  });
  test.each([
    ['game-tick', 200, '{"success":true}', 'completed', undefined],
    ['game-tick', 200, '{"success":true,"skipped":true}', 'skipped', undefined],
    ['game-tick', 200, '{"success":false}', 'failed', undefined],
    ['game-tick', 200, 'invalid JSON', 'unknown', undefined],
    ['game-tick', 503, '{"success":true}', 'failed', undefined],
    [
      'game-tick',
      200,
      '{"skipped":true,"reason":"Game disabled via GAME_START environment variable"}',
      'skipped',
      'game_disabled',
    ],
    [
      'markets-tick',
      200,
      '{"skipped":true,"reason":"Game not running"}',
      'skipped',
      'game_not_running',
    ],
    [
      'npc-tick',
      200,
      '{"skipped":true,"reason":"Inference budget exhausted or suspended"}',
      'skipped',
      'inference_budget_exhausted_or_suspended',
    ],
    [
      'realtime-drain',
      200,
      '{"skipped":true,"reason":"Game not running"}',
      'skipped',
      undefined,
    ],
    [
      'game-tick',
      200,
      '{"skipped":true,"reason":"Unexpected route detail"}',
      'skipped',
      undefined,
    ],
    [
      'game-tick',
      200,
      '{"success":true,"reason":"Game paused"}',
      'completed',
      undefined,
    ],
  ])('logs %s status %s and body %s as %s', async (job, status, body, outcome, skipReason) => {
    const path = `/api/cron/${job}`;
    const scheduledTime = Date.parse('2026-10-10T00:00:00Z');
    let acknowledged = false;
    const worker = (await import(workerUrl)).default as { queue: WorkerQueue };
    const log = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const delivery = worker.queue(
        {
          messages: [
            {
              body: { path, scheduledTime },
              attempts: 2,
              ack: () => {
                acknowledged = true;
              },
            },
          ],
        },
        {
          APP: {
            fetch: async () =>
              new Response(body, {
                status,
                headers: { 'content-type': 'application/json' },
              }),
          },
          APP_ORIGIN: 'https://app.example',
          CRON_SECRET: 'secret',
          CRON_ENABLED: 'true',
        },
        {}
      );
      if (status === 503) {
        await expect(delivery).rejects.toThrow('HTTP 503');
      } else {
        await delivery;
      }
      expect(acknowledged).toBe(status === 200);
      expect(log).toHaveBeenCalledWith({
        event: 'cron_delivery',
        job: path,
        scheduledTime,
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
        attempt: 2,
        httpStatus: status,
        outcome,
        ...(skipReason ? { skipReason } : {}),
      });
    } finally {
      log.mockRestore();
    }
  });
  test('queue messages cannot invoke arbitrary routes', () => {
    expect(isCronJob({ path: '/api/admin/delete', scheduledTime: 0 })).toBe(
      false
    );
    expect(isCronJob({ path: jobs[0].path, scheduledTime: Number.NaN })).toBe(
      false
    );
    expect(isCronJob({ path: jobs[0].path, scheduledTime: 0 })).toBe(true);
    for (const { path } of localnetJobs) {
      expect(isCronJob({ path, scheduledTime: 0 })).toBe(false);
      expect(isCronJob({ path, scheduledTime: 0 }, true)).toBe(true);
    }
    for (const path of [
      '/api/cron/agent-tick',
      '/api/cron/reputation-sync',
      '/api/cron/profile-chain-sync',
    ]) {
      expect(isCronJob({ path, scheduledTime: 0 })).toBe(false);
    }
    expect(() => dueJobs(Number.NaN)).toThrow();
  });
});
