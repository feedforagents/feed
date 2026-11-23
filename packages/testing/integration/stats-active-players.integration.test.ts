/** PRD §6.1 / §12: public platform stats count eligible active players. */
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
  runIsolatedStatsActivePlayersCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the active players cases in a leased fresh database', async () => {
    await runIsolatedStatsActivePlayersCases();
  }, 300_000);
} else {
  // Active players is the same 7-day active-user concept as WAU in
  // GET /api/admin/stats/growth, which excludes actors, agents and banned
  // users. A leased database keeps concurrent writers out of the
  // assertions and retires fixtures without row deletes.
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { db, eq, userActivityLogs, users } = await import('@feed/db');
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
    stats: { activePlayers: number };
  }

  let regularId: string;
  let bannedId: string;
  let agentId: string;
  let baseline: number;

  async function readActivePlayers(): Promise<number> {
    const requestId = crypto.randomUUID();
    const response = await fetch(
      new URL('/api/feed/widgets/stats', server.url),
      { headers: { 'x-request-id': requestId } }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatsBody;
    expect(body.success).toBe(true);
    expect(Number.isInteger(body.stats.activePlayers)).toBe(true);
    console.info('Stats HTTP response', {
      requestId,
      status: response.status,
      activePlayers: body.stats.activePlayers,
    });
    return body.stats.activePlayers;
  }

  async function logRecentActivity(userId: string): Promise<void> {
    await db.insert(userActivityLogs).values({
      id: await generateSnowflakeId(),
      userId,
      activityType: 'login',
      activityDate: new Date(),
      createdAt: new Date(),
    });
  }

  beforeAll(async () => {
    regularId = await generateSnowflakeId();
    bannedId = await generateSnowflakeId();
    agentId = await generateSnowflakeId();
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    baseline = await readActivePlayers();
    // One eligible player with recent activity.
    await db.insert(users).values({
      id: regularId,
      username: `sap${regularId}`,
      displayName: 'Stats active players fixture',
      isTest: false,
      isActor: false,
      isAgent: false,
      isBanned: false,
      createdAt: now,
      updatedAt: now,
    });
    await logRecentActivity(regularId);
    // A banned user and an agent account, both recently active.
    await db.insert(users).values([
      {
        id: bannedId,
        username: `sap${bannedId}`,
        displayName: 'Stats active players fixture (banned)',
        isTest: false,
        isActor: false,
        isAgent: false,
        isBanned: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: agentId,
        username: `sap${agentId}`,
        displayName: 'Stats active players fixture (agent)',
        isTest: false,
        isActor: false,
        isAgent: true,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await logRecentActivity(bannedId);
    await logRecentActivity(agentId);
    // An actor with recent activity (already excluded) and an eligible
    // player whose only activity is 8 days old (outside the 7-day window).
    const actorId = await generateSnowflakeId();
    const staleId = await generateSnowflakeId();
    await db.insert(users).values([
      {
        id: actorId,
        username: `sap${actorId}`,
        displayName: 'Stats active players fixture (actor)',
        isTest: false,
        isActor: true,
        isAgent: false,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: staleId,
        username: `sap${staleId}`,
        displayName: 'Stats active players fixture (stale)',
        isTest: false,
        isActor: false,
        isAgent: false,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await logRecentActivity(actorId);
    await db.insert(userActivityLogs).values({
      id: await generateSnowflakeId(),
      userId: staleId,
      activityType: 'login',
      activityDate: eightDaysAgo,
      createdAt: eightDaysAgo,
    });
  });

  afterAll(async () => {
    try {
      await server.stop(true);
    } finally {
      await db.$disconnect();
    }
  });

  describe('Platform stats count only eligible active players', () => {
    it('counts only the eligible player among recent activity', async () => {
      expect(await readActivePlayers()).toBe(baseline + 1);
    });

    it('unbanning a player raises the count, banning lowers it again', async () => {
      const now = new Date();
      const before = await readActivePlayers();
      expect(before).toBe(baseline + 1);

      await db
        .update(users)
        .set({ isBanned: false, updatedAt: now })
        .where(eq(users.id, bannedId));
      expect(await readActivePlayers()).toBe(before + 1);

      await db
        .update(users)
        .set({ isBanned: true, updatedAt: now })
        .where(eq(users.id, bannedId));
      expect(await readActivePlayers()).toBe(before);
    });

    it('clearing the agent flag raises the count', async () => {
      const now = new Date();
      const before = await readActivePlayers();
      expect(before).toBe(baseline + 1);

      await db
        .update(users)
        .set({ isAgent: false, updatedAt: now })
        .where(eq(users.id, agentId));
      expect(await readActivePlayers()).toBe(before + 1);
    });
  });
}
