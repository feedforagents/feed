/** MCP website follow-list population. PRD §§8.1/12 and MVP Phases 3/5. */
import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP follow list population';
const cases = {
  followersPopulation:
    'get_followers returns only real, non-test, non-banned users',
  followersLimit:
    'get_followers applies the population filter before the limit',
  followingPopulation:
    'get_following returns only real, non-test, non-banned users',
  followingLimit:
    'get_following applies the population filter before the limit',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP follow lists in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-follow-lists-population',
      file: 'packages/testing/integration/mcp-follow-lists-population.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { closeDatabase, db, follows, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { executeGetFollowers, executeGetFollowing } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  let agentUserId: string;
  let targetId: string;
  let sourceId: string;
  let normalAId: string;
  let normalBId: string;

  async function createUser(
    overrides: Partial<typeof users.$inferInsert> = {}
  ): Promise<string> {
    const id = overrides.id ?? crypto.randomUUID();
    const inserted = await db
      .insert(users)
      .values({
        id,
        username: `f185_${id.replace(/-/g, '').slice(-10)}`,
        isActor: false,
        updatedAt: new Date(),
        ...overrides,
      })
      .returning({ id: users.id });
    if (!inserted[0]) throw new Error('User fixture insert returned no row');
    return inserted[0].id;
  }

  async function createFollow(
    followerId: string,
    followingId: string,
    createdAt: Date
  ): Promise<void> {
    const id = await generateSnowflakeId();
    const inserted = await db
      .insert(follows)
      .values({ id, followerId, followingId, createdAt })
      .returning({ id: follows.id });
    if (!inserted[0]) throw new Error('Follow fixture insert returned no row');
  }

  describe(suite, () => {
    const agent = () => ({ agentId: 'agent', userId: agentUserId });

    beforeAll(async () => {
      agentUserId = await createUser();
      targetId = await createUser();
      sourceId = await createUser();
      normalAId = await createUser();
      normalBId = await createUser();
      const isTestId = await createUser({ isTest: true });
      const testPrefixId = await createUser({
        id: `test-${crypto.randomUUID()}`,
      });
      const bannedId = await createUser({ isBanned: true });
      // A follow row whose other side has no User row at all.
      const ghostId = crypto.randomUUID();

      const base = Date.now() - 60_000;
      // Excluded rows are the newest, so an unfiltered take of any size
      // surfaces them first. The eligible edges tie on time and sort by relation ID.
      const members: Array<[string, number]> = [
        [normalAId, 0],
        [normalBId, 0],
        [isTestId, 20_000],
        [testPrefixId, 30_000],
        [bannedId, 40_000],
        [ghostId, 50_000],
      ];
      for (const [memberId, offset] of members) {
        const at = new Date(base + offset);
        await createFollow(memberId, targetId, at); // member follows target
        await createFollow(sourceId, memberId, at); // source follows member
      }
    });

    afterAll(async () => {
      await closeDatabase();
    }, 10_000);

    it(cases.followersPopulation, async () => {
      const result = await executeGetFollowers(agent(), { userId: targetId });
      expect(result.followers.map((f) => f.id)).toEqual([normalBId, normalAId]);
      expect(result.followers.every((f) => f.username !== null)).toBe(true);
    });

    it(cases.followersLimit, async () => {
      const result = await executeGetFollowers(agent(), {
        userId: targetId,
        limit: 2,
      });
      expect(result.followers.map((f) => f.id)).toEqual([normalBId, normalAId]);
    });

    it(cases.followingPopulation, async () => {
      const result = await executeGetFollowing(agent(), { userId: sourceId });
      expect(result.following.map((f) => f.id)).toEqual([normalBId, normalAId]);
      expect(result.following.every((f) => f.username !== null)).toBe(true);
    });

    it(cases.followingLimit, async () => {
      const result = await executeGetFollowing(agent(), {
        userId: sourceId,
        limit: 2,
      });
      expect(result.following.map((f) => f.id)).toEqual([normalBId, normalAId]);
    });
  });
}
