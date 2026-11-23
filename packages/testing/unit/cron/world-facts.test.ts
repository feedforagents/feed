import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { DistributedLockService } from '@feed/api';
import * as dbModule from '@feed/db';
import * as engine from '@feed/engine';
import { NextRequest } from 'next/server';

const environment = { ...process.env };
const feeds = mock(async () => ({ fetched: 2, stored: 3, errors: 1 }));
const getHeadlines = mock(async () => [{ id: 'headline-1' }]);
const processHeadlines = mock(async () => [{ id: 'parody-1' }]);
const cleanup = mock(async () => 4);
const dailyTopic = mock(async () => null);
const generateFacts = mock(async () => ({
  generated: 1,
  archived: 0,
  sources: { events: 1, markets: 0, questions: 0, actors: 0 },
}));
const consolidateFacts = mock(async () => ({
  consolidated: 0,
  archived: 0,
  skipped: 0,
}));
const getGame = mock(async () => [{ isRunning: true }]);

mock.module('@feed/db', () => ({
  ...dbModule,
  dbWrite: {
    select: () => ({
      from: () => ({ where: () => ({ limit: getGame }) }),
    }),
  },
}));
mock.module('@feed/engine', () => ({
  ...engine,
  rssFeedService: {
    fetchAllFeeds: feeds,
    getUntransformedHeadlines: getHeadlines,
    cleanupOldHeadlines: cleanup,
  },
  dailyTopicService: { ensureTopicForDate: dailyTopic },
  worldFactsGenerator: { generateNewWorldFacts: generateFacts },
  FeedLLMClient: { forGameTick: () => ({}) },
  WorldFactsConsolidator: class {
    consolidateFacts = consolidateFacts;
  },
  createParodyHeadlineGenerator: () => ({ processHeadlines }),
}));

const { GET } = await import(
  '../../../../apps/web/src/app/api/cron/world-facts/route'
);

const originalAcquire = DistributedLockService.acquireLock;
const originalRelease = DistributedLockService.releaseLock;
const acquire = mock(async () => true);
const release = mock(async () => {});
const request = (query = '?mode=headlines', secret = 'local-cron-secret') =>
  new NextRequest(`http://localhost/api/cron/world-facts${query}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });

beforeEach(() => {
  process.env.CRON_SECRET = 'local-cron-secret';
  process.env.DEPLOYMENT_ENV = 'localnet';
  process.env.GAME_START = 'true';
  DistributedLockService.acquireLock = acquire;
  DistributedLockService.releaseLock = release;
});

afterEach(() => {
  DistributedLockService.acquireLock = originalAcquire;
  DistributedLockService.releaseLock = originalRelease;
  mock.clearAllMocks();
  process.env = { ...environment };
});

test('headline mode fetches RSS and limits parody work under the job lease', async () => {
  const response = await GET(request());

  expect(await response.json()).toMatchObject({
    success: true,
    stats: { feedsFetched: 2, newHeadlines: 3, parodiesGenerated: 1 },
  });
  expect(feeds).toHaveBeenCalledWith({
    signal: expect.any(AbortSignal),
    attempts: 1,
    timeoutMs: 4000,
  });
  expect(getHeadlines).toHaveBeenCalledWith(1);
  expect(processHeadlines).toHaveBeenCalledWith(
    [{ id: 'headline-1' }],
    expect.any(AbortSignal)
  );
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      lockId: 'world-headlines',
      durationMs: 120_000,
      processId: expect.any(String),
    })
  );
  expect(release).toHaveBeenCalledWith('world-headlines', expect.any(String));
  expect(generateFacts).not.toHaveBeenCalled();
});

test('plain localnet job consolidates world facts without refreshing headlines', async () => {
  const response = await GET(request(''));

  expect(await response.json()).toMatchObject({
    success: true,
    stats: { headlinesCleaned: 4, worldFactsGenerated: 1 },
  });
  expect(consolidateFacts).toHaveBeenCalledTimes(1);
  expect(feeds).not.toHaveBeenCalled();
  expect(processHeadlines).not.toHaveBeenCalled();
});

test('headline work is skipped when paused, leased or outside localnet', async () => {
  getGame.mockResolvedValueOnce([{ isRunning: false }]);
  expect(await (await GET(request())).json()).toMatchObject({
    skipped: true,
    reason: 'Continuous game is not running',
  });

  acquire.mockResolvedValueOnce(false);
  expect(await (await GET(request())).json()).toMatchObject({
    skipped: true,
    reason: 'Previous headline refresh is still running',
  });

  process.env.DEPLOYMENT_ENV = 'staging';
  expect(await (await GET(request())).json()).toMatchObject({
    skipped: true,
  });

  expect(feeds).not.toHaveBeenCalled();
  expect(processHeadlines).not.toHaveBeenCalled();
});

test('hosted plain job retains its existing headline work', async () => {
  process.env.DEPLOYMENT_ENV = 'staging';
  const response = await GET(request(''));

  expect(await response.json()).toMatchObject({
    success: true,
    stats: { feedsFetched: 2, parodiesGenerated: 1, worldFactsGenerated: 1 },
  });
  expect(getHeadlines).toHaveBeenCalledWith(20);
  expect(consolidateFacts).toHaveBeenCalledTimes(1);
});

test('preserves an honest RSS count and releases the owner when parody fails', async () => {
  processHeadlines.mockRejectedValueOnce(new Error('provider unavailable'));

  expect(await (await GET(request())).json()).toMatchObject({
    success: false,
    failedStages: ['parodies'],
    stats: { feedsFetched: 2, parodiesGenerated: 0 },
  });
  expect(release).toHaveBeenCalledTimes(1);
});

test('requires cron authentication before attempting headline work', async () => {
  expect((await GET(request('?mode=headlines', 'invalid'))).status).toBe(403);
  expect(feeds).not.toHaveBeenCalled();
});

test('reports zero successful sources as an RSS failure', async () => {
  feeds.mockResolvedValueOnce({ fetched: 0, stored: 0, errors: 2 });
  getHeadlines.mockResolvedValueOnce([]);

  expect(await (await GET(request())).json()).toMatchObject({
    success: false,
    failedStages: ['rss'],
    stats: { feedsFetched: 0, newHeadlines: 0, parodiesGenerated: 0 },
  });
  expect(processHeadlines).not.toHaveBeenCalled();
});
