import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const ensureEngineServicesMock = mock(() => undefined);
const relayCronToStagingMock = mock(async () => ({ forwarded: false }));

const ensureEngineServicesPath = new URL(
  '../../../../apps/web/src/lib/engine/ensure-engine-services.ts',
  import.meta.url
).pathname;
mock.module(ensureEngineServicesPath, () => ({
  ensureEngineServices: ensureEngineServicesMock,
}));

const lastTick = mock((): Date | null => null);
const clockStep = mock(
  async (_skipContent: boolean, _skip: Set<string>, _scheduledAt: Date) => ({
    eventsCreated: 0,
    marketsUpdated: 0,
  })
);
const lookahead = mock<typeof import('@feed/engine').checkLookaheadStatus>(
  async () => {
    throw new Error('The minute clock must not use lookahead');
  }
);

const actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ...actualDb,
  asSystem: async () => ({
    id: 'game',
    isRunning: true,
    isContinuous: true,
    currentDay: 1,
    pausedAt: null,
    startedAt: new Date(0),
    lastTickAt: lastTick(),
  }),
}));

const actualEngine = await import('@feed/engine');
mock.module('@feed/engine', () => ({
  ...actualEngine,
  bootstrapGameIfNeeded: async () => null,
  checkLookaheadStatus: lookahead,
  executeGameTick: clockStep,
}));

const actualFeedApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ...actualFeedApi,
  acquireGenerationLock: async () => true,
  relayCronToStaging: relayCronToStagingMock,
  releaseGenerationLock: async () => undefined,
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(request),
}));

const { GET, POST } = await import(
  '../../../../apps/web/src/app/api/cron/game-tick/route'
);

describe('game-tick cron auth', () => {
  beforeEach(() => {
    ensureEngineServicesMock.mockClear();
    relayCronToStagingMock.mockClear();
  });

  test('GET uses the same handler as POST', () => {
    expect(GET).toBe(POST);
  });

  test('a vercel-cron user-agent is not accepted as a credential', async () => {
    const request = new NextRequest('https://feed.fun/api/cron/game-tick', {
      method: 'GET',
      headers: {
        'user-agent': 'vercel-cron/1.0',
        'x-vercel-id': 'spoofed',
        authorization: 'Bearer wrong-secret',
      },
    });

    await expect(GET(request)).rejects.toThrow('Unauthorized cron request');
    expect(ensureEngineServicesMock).not.toHaveBeenCalled();
    expect(relayCronToStagingMock).not.toHaveBeenCalled();
  });
});

describe('game clock execution', () => {
  const env = new Map<string, string | undefined>();
  const settings = {
    CRON_SECRET: 'test-game-clock-secret',
    DEPLOYMENT_ENV: 'localnet',
    ENABLE_INTERNAL_CRON_SCHEDULER: 'false',
    GAME_START: 'true',
  };

  beforeEach(() => {
    for (const [name, value] of Object.entries(settings)) {
      env.set(name, process.env[name]);
      process.env[name] = value;
    }
    clockStep.mockClear();
    lookahead.mockClear();
    actualFeedApi.cronMetrics.reset();
    lastTick.mockReturnValue(null);
  });

  afterEach(() => {
    for (const [name, value] of env) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    actualFeedApi.cronMetrics.reset();
  });

  function request(time: number) {
    return new NextRequest('https://feed.fun/api/cron/game-tick', {
      headers: {
        authorization: `Bearer ${settings.CRON_SECRET}`,
        'x-cloudflare-cron-time': String(time),
      },
    });
  }

  test('applies world state without generating lookahead', async () => {
    const now = Date.now();
    const response = await GET(request(now));
    expect(response.status).toBe(200);
    expect(clockStep).toHaveBeenCalledWith(
      true,
      new Set(['scheduled-generation']),
      new Date(now)
    );
    expect(lookahead).not.toHaveBeenCalled();
  });

  test('skips redelivery after the world clock has committed', async () => {
    const now = Date.now();
    lastTick.mockReturnValue(new Date(now));
    expect(await (await GET(request(now))).json()).toMatchObject({
      skipped: true,
      reason: 'Game clock already advanced',
    });
    expect(clockStep).not.toHaveBeenCalled();
    expect(lookahead).not.toHaveBeenCalled();
  });

  test('records hosted game ticks when the lookahead buffer is sufficient', async () => {
    process.env.DEPLOYMENT_ENV = 'staging';
    const now = Date.now();
    lookahead.mockResolvedValueOnce({
      minutesAhead: 30,
      latestTimestamp: new Date(now + 30 * 60_000),
      needsGeneration: false,
    });

    const response = await GET(request(now));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      bufferSufficient: true,
    });
    expect(actualFeedApi.cronMetrics.getJobStats('game-tick')).toMatchObject({
      successfulExecutions: 1,
      lastSuccess: expect.any(Date),
    });
  });
});
