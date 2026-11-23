import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET as runFundingCron } from '../app/api/cron/perp-funding/route';
import {
  isInternalCronSchedulerEnabled,
  triggerScheduledCrons,
} from './cron-scheduler';

const env = process.env as Record<string, string | undefined>;
const saved = {
  CRON_SECRET: env.CRON_SECRET,
  DEPLOYMENT_ENV: env.DEPLOYMENT_ENV,
  DEPLOYMENT_PLATFORM: env.DEPLOYMENT_PLATFORM,
  ENABLE_INTERNAL_CRON_SCHEDULER: env.ENABLE_INTERNAL_CRON_SCHEDULER,
  NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: env.NODE_ENV,
  PERP_FUNDING_FIRST_PERIOD: env.PERP_FUNDING_FIRST_PERIOD,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

it.each([
  'staging',
  'localnet',
])('sends the canonical funding boundary from %s internal scheduling', async (deployment) => {
  const observed: Array<{
    timestamp: string | null;
    status: number;
    body: object;
  }> = [];
  const period = new Date('2026-10-10T00:00:00Z');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/api/cron/perp-funding') {
        return new Response(null, { status: 204 });
      }
      const response = await runFundingCron(new NextRequest(request));
      observed.push({
        timestamp: request.headers.get('X-Cloudflare-Cron-Time'),
        status: response.status,
        body: await response.clone().json(),
      });
      return response;
    },
  });
  env.CRON_SECRET = 'local-funding-fixture';
  env.DEPLOYMENT_ENV = deployment;
  env.NEXT_PUBLIC_APP_URL = server.url.origin;
  // The request must validate the scheduled date before the cutover guard
  // can return. Keeping the test before cutover prevents all funding writes.
  env.PERP_FUNDING_FIRST_PERIOD = '2026-10-10T08:00:00Z';
  try {
    await triggerScheduledCrons(new Date(period.getTime() + 37_125));
    expect(observed).toEqual([
      {
        timestamp: String(period.getTime()),
        status: 200,
        body: { success: true, skipped: 'before-funding-cutover' },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

describe('isInternalCronSchedulerEnabled', () => {
  it('is off on hosted production unless explicitly enabled', () => {
    delete env.DEPLOYMENT_PLATFORM;
    delete env.ENABLE_INTERNAL_CRON_SCHEDULER;
    env.NODE_ENV = 'production';
    expect(isInternalCronSchedulerEnabled()).toBe(false);
    env.ENABLE_INTERNAL_CRON_SCHEDULER = 'true';
    expect(isInternalCronSchedulerEnabled()).toBe(true);
  });

  it('defaults on in local development and never runs on Cloudflare', () => {
    delete env.ENABLE_INTERNAL_CRON_SCHEDULER;
    env.NODE_ENV = 'development';
    delete env.DEPLOYMENT_PLATFORM;
    expect(isInternalCronSchedulerEnabled()).toBe(true);
    env.DEPLOYMENT_PLATFORM = 'cloudflare';
    env.ENABLE_INTERNAL_CRON_SCHEDULER = 'true';
    expect(isInternalCronSchedulerEnabled()).toBe(false);
  });
});

it('dispatches localnet auxiliary jobs at the supplied UTC time only', async () => {
  const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}')
  );
  const headlines = '/api/cron/world-facts?mode=headlines';
  const groups = '/api/cron/npc-tick?mode=groups';
  const recovery = '/api/cron/markets-recovery';
  env.CRON_SECRET = 'local-cron-test';
  env.DEPLOYMENT_ENV = 'localnet';
  try {
    const scheduled = new Date('2026-10-10T06:00:00Z');
    const due = await triggerScheduledCrons(scheduled);
    expect(due.triggered).toContain(headlines);
    expect(due.triggered).toContain(groups);
    expect(due.triggered).toContain('/api/cron/world-facts');
    expect(due.triggered).not.toContain(recovery);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)
    ).toContain(recovery);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).search)
    ).toContain('?mode=headlines');
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('X-Cloudflare-Cron-Time')).toBe(
        String(scheduled.getTime())
      );
    }
    const between = await triggerScheduledCrons(
      new Date('2026-10-10T06:01:00Z')
    );
    expect(between.skipped).toContain(headlines);
    expect(between.skipped).toContain(groups);

    env.DEPLOYMENT_ENV = 'staging';
    fetcher.mockClear();
    const hosted = await triggerScheduledCrons(
      new Date('2026-10-10T06:00:00Z')
    );
    expect(hosted.triggered).toContain('/api/cron/world-facts');
    expect(hosted.triggered).not.toContain(headlines);
    expect(hosted.triggered).not.toContain(groups);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)
    ).not.toContain(recovery);
  } finally {
    fetcher.mockRestore();
  }
});

it('reports failures and skips from successful HTTP deliveries', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case '/api/cron/article-tick':
          return Response.json({
            success: false,
            skipped: false,
            errorCount: 1,
            articlesCreated: 0,
          });
        case '/api/cron/organization-tick':
          return Response.json({ success: true, skipped: true });
        case '/api/cron/npc-tick':
          return Response.json({ success: false, skipped: true });
        case '/api/cron/health-check':
          return new Response(null, { status: 503 });
        case '/api/cron/metrics-snapshot':
          return new Response('legacy response');
        default:
          return Response.json({ success: true });
      }
    },
  });
  env.CRON_SECRET = 'local-cron-test';
  env.DEPLOYMENT_ENV = 'staging';
  env.NEXT_PUBLIC_APP_URL = server.url.origin;
  try {
    const result = await triggerScheduledCrons(
      new Date('2026-10-10T06:00:00Z')
    );
    expect(result.failed).toEqual([
      '/api/cron/npc-tick',
      '/api/cron/article-tick',
      '/api/cron/health-check',
    ]);
    expect(result.skipped).toContain('/api/cron/organization-tick');
    expect(result.triggered).toContain('/api/cron/markets-tick');
    expect(result.triggered).toContain('/api/cron/metrics-snapshot');
    expect(result.triggered).not.toContain('/api/cron/organization-tick');
  } finally {
    await server.stop(true);
  }
});
