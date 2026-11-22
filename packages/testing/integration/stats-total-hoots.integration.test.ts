/** PRD §6.1 / §12 / MVP Phase 5: public platform stats count reachable posts. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test';
import {
  runIsolatedStatsTotalHootsCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the public stats cases in a leased fresh database', async () => {
    await runIsolatedStatsTotalHootsCases();
  }, 300_000);
} else {
  // This endpoint counts all posts. A leased database keeps concurrent
  // writers out of the assertions and retires fixtures without row deletes.
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { db, eq, posts, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/stats/route'
  );
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => GET(new NextRequest(request)),
  });

  interface StatsBody {
    success: boolean;
    stats: { totalHoots: number };
  }

  let authorId: string;
  let visibleId: string;
  let futureId: string;
  let baseline: number;

  async function readTotalHoots(): Promise<number> {
    const requestId = crypto.randomUUID();
    const response = await fetch(
      new URL('/api/feed/widgets/stats', server.url),
      { headers: { 'x-request-id': requestId } }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatsBody;
    expect(body.success).toBe(true);
    expect(Number.isInteger(body.stats.totalHoots)).toBe(true);
    console.info('Stats HTTP response', {
      requestId,
      status: response.status,
      totalHoots: body.stats.totalHoots,
    });
    return body.stats.totalHoots;
  }

  beforeAll(async () => {
    authorId = await generateSnowflakeId();
    visibleId = await generateSnowflakeId();
    futureId = await generateSnowflakeId();
    const now = new Date();
    const past = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    baseline = await readTotalHoots();
    await db.insert(users).values({
      id: authorId,
      username: `sth${authorId}`,
      displayName: 'Stats hoots fixture',
      isTest: false,
      updatedAt: now,
    });
    await db.insert(posts).values([
      {
        id: visibleId,
        content: 'Stats hoots fixture (visible)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: null,
      },
      {
        id: await generateSnowflakeId(),
        content: 'Stats hoots fixture (moderated)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: past,
      },
      {
        id: futureId,
        content: 'Stats hoots fixture (scheduled)',
        authorId,
        timestamp: future,
        createdAt: past,
        deletedAt: null,
      },
    ]);
  });

  afterAll(async () => {
    try {
      await server.stop(true);
    } finally {
      await db.$disconnect();
    }
  });

  describe('Platform stats count only reachable posts', () => {
    it('adds only the reachable fixture post to the platform total', async () => {
      expect(await readTotalHoots()).toBe(baseline + 1);
    });

    it('still moves for content readers can see', async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await db.insert(posts).values({
        id: await generateSnowflakeId(),
        content: 'Stats hoots fixture (extra visible)',
        authorId,
        timestamp: past,
        createdAt: past,
        deletedAt: null,
      });
      expect(await readTotalHoots()).toBe(baseline + 2);
    });

    it('follows moderation: publishing a scheduled post raises the total, removing one lowers it', async () => {
      const now = new Date();
      const before = await readTotalHoots();
      expect(before).toBe(baseline + 2);

      await db
        .update(posts)
        .set({ timestamp: new Date(now.getTime() - 60 * 60 * 1000) })
        .where(eq(posts.id, futureId));
      expect(await readTotalHoots()).toBe(before + 1);

      await db
        .update(posts)
        .set({ deletedAt: now })
        .where(eq(posts.id, visibleId));
      expect(await readTotalHoots()).toBe(before);

      await db
        .update(posts)
        .set({ deletedAt: null })
        .where(eq(posts.id, visibleId));
      expect(await readTotalHoots()).toBe(before + 1);
    });
  });
}
