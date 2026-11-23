/** PRD §§6.1/12 and MVP Phase 5: the widget and RSS honor the news limit. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const modes = ['public', 'signed'] as const;
const defaultCase = 'keeps the configured three-item cap with no limit';
const largerCase = 'honors a limit above the default';
const oneCase = 'returns the newest public item for limit=1';
const invalidCase = 'rejects an out-of-range limit';
const boundaryCase = 'excludes non-public and future events';
const identityCase = 'resolves the signed session to the fixture user';
const rssCase = 'serves more than three items through the public RSS route';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs breaking-news widget and RSS in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'breaking-news-limit',
      file: 'packages/testing/integration/breaking-news-widget-limit.integration.test.ts',
      cases: [
        identityCase,
        ...modes.flatMap((mode) =>
          [defaultCase, largerCase, oneCase, invalidCase, boundaryCase].map(
            (name) => `${mode} ${name}`
          )
        ),
        rssCase,
      ],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();

  const { optionalAuth } = await import('@feed/api');
  const { db, users, worldEvents } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { z } = await import('zod');
  const { GET: widget } = await import(
    '../../../apps/web/src/app/api/feed/widgets/breaking-news/route'
  );
  const { GET: rss } = await import(
    '../../../apps/web/src/app/feed/breaking-news/rss/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const widgetPath = '/api/feed/widgets/breaking-news';
  const rssPath = '/feed/breaking-news/rss';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === widgetPath) return widget(new NextRequest(request));
      if (path === rssPath) return rss(new NextRequest(request));
      return new Response(null, { status: 404 });
    },
  });
  afterAll(async () => {
    await server.stop(true);
  });

  const [newestPublicId, ...olderPublicIds] = await Promise.all([
    generateSnowflakeId(),
    ...Array.from({ length: 4 }, () => generateSnowflakeId()),
  ] as const);
  const publicIds = [newestPublicId, ...olderPublicIds];
  const privateId = await generateSnowflakeId();
  const futureId = await generateSnowflakeId();
  const stewardUserId = await generateSnowflakeId();
  const stewardClaim = `steward-bn-${stewardUserId}`;
  const stewardToken = await createStewardTestToken(stewardClaim);
  const signedHeaders = { Authorization: `Bearer ${stewardToken}` };
  const publicDescription = 'Breaking news limit fixture';

  beforeAll(async () => {
    const now = Date.now();
    const event = (id: string, description: string, timestamp: Date) => ({
      id,
      description,
      timestamp,
      createdAt: timestamp,
      eventType: 'announcement',
      gameId: 'continuous',
    });
    await db.transaction(async (tx) => {
      await tx.insert(worldEvents).values([
        ...publicIds.map((id, index) => ({
          ...event(
            id,
            `${publicDescription} ${index}`,
            new Date(now - 5_000 - index * 1_000)
          ),
          visibility: 'public',
        })),
        {
          // The private event is newer than the public rows and already due.
          ...event(
            privateId,
            'Non-public boundary fixture',
            new Date(now - 1_000)
          ),
          visibility: 'private',
        },
        {
          ...event(
            futureId,
            'Future boundary fixture',
            new Date(now + 86_400_000)
          ),
          visibility: 'public',
        },
      ]);
      await tx.insert(users).values({
        id: stewardUserId,
        username: `test-bn-${stewardUserId}`,
        stewardId: stewardClaim,
        profileComplete: true,
        updatedAt: new Date(),
      });
    });
  });

  const responseSchema = z.object({
    news: z.array(z.object({ id: z.string() })).optional(),
  });
  async function requestNews(mode: (typeof modes)[number], query = '') {
    const response = await fetch(new URL(widgetPath + query, server.url), {
      headers: mode === 'signed' ? signedHeaders : undefined,
    });
    const result = responseSchema.parse(await response.json());
    return {
      status: response.status,
      ids: result.news?.map(({ id }) => id) ?? [],
    };
  }

  test(identityCase, async () => {
    const identity = await optionalAuth(
      new NextRequest(new URL(widgetPath, server.url), {
        headers: signedHeaders,
      })
    );
    expect(identity?.userId).toBe(stewardUserId);
  });

  for (const mode of modes) {
    test(`${mode} ${defaultCase}`, async () => {
      const { status, ids } = await requestNews(mode);
      expect(status).toBe(200);
      expect(ids).toHaveLength(3);
      expect(ids[0]).toBe(newestPublicId);
    });

    test(`${mode} ${largerCase}`, async () => {
      const { status, ids } = await requestNews(mode, '?limit=10');
      expect(status).toBe(200);
      expect(ids).toHaveLength(5);
      expect(ids).toEqual(expect.arrayContaining(publicIds));
    });

    test(`${mode} ${oneCase}`, async () => {
      const { status, ids } = await requestNews(mode, '?limit=1');
      expect(status).toBe(200);
      expect(ids).toEqual([newestPublicId]);
    });

    test(`${mode} ${invalidCase}`, async () => {
      const { status } = await requestNews(mode, '?limit=99');
      expect(status).toBe(400);
    });

    test(`${mode} ${boundaryCase}`, async () => {
      const { status, ids } = await requestNews(mode, '?limit=10');
      expect(status).toBe(200);
      expect(ids).not.toContain(privateId);
      expect(ids).not.toContain(futureId);
    });
  }

  test(rssCase, async () => {
    const response = await fetch(new URL(rssPath, server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/rss+xml'
    );
    const xml = await response.text();
    expect(xml.match(/<item>/g)).toHaveLength(publicIds.length);
    expect(xml).toContain(`${publicDescription} 4`);
    expect(xml).not.toContain('Non-public boundary fixture');
    expect(xml).not.toContain('Future boundary fixture');
  });
}
