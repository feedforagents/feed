/**
 * MCP mute_user must match the web route's target-existence check.
 * Use an exclusive fixture database so a failed setup cannot authorize
 * deleting an existing account or moderation relation.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP mute_user target existence';
const unknownCase =
  'rejects a mute on an unknown user without writing a mute row';
const realCase = 'mutes a real user and lists them with their identity';
const repeatCase = 'does not mute twice for a repeated mute';
const selfCase = 'still rejects muting yourself';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { and, db, eq, userMutes, users } = await import('@feed/db');
  const { executeGetMutes, executeMuteUser } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const ghostId = 'f177-ghost-mute-00000000-0000-4000-8000-0000000000aa';
  const agentUserId = crypto.randomUUID();
  const realUserId = crypto.randomUUID();
  const npcUserId = crypto.randomUUID();
  const agent = { agentId: 'agent', userId: agentUserId };
  const realUsername = 'f177-target';

  function muteRowsFor(targetId: string) {
    return db
      .select({ id: userMutes.id })
      .from(userMutes)
      .where(
        and(eq(userMutes.muterId, agentUserId), eq(userMutes.mutedId, targetId))
      );
  }

  beforeAll(async () => {
    await db.insert(users).values([
      {
        id: agentUserId,
        username: 'f177-caller',
        updatedAt: new Date(),
      },
      {
        id: realUserId,
        username: realUsername,
        updatedAt: new Date(),
      },
      {
        id: npcUserId,
        username: 'f177-npc',
        isActor: true,
        updatedAt: new Date(),
      },
    ]);
    const ghosts = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, ghostId));
    expect(ghosts).toHaveLength(0);
  });

  describe(suite, () => {
    it(unknownCase, async () => {
      await expect(executeMuteUser(agent, { userId: ghostId })).rejects.toThrow(
        'not found'
      );
      expect(await muteRowsFor(ghostId)).toHaveLength(0);
    });

    it(realCase, async () => {
      expect(await executeMuteUser(agent, { userId: realUserId })).toEqual({
        success: true,
      });
      expect(await muteRowsFor(realUserId)).toHaveLength(1);

      const mutes = await executeGetMutes(agent, {});
      expect(
        mutes.mutedUsers.find((entry) => entry.userId === realUserId)
      ).toMatchObject({ username: realUsername });
    });

    it(repeatCase, async () => {
      expect(await executeMuteUser(agent, { userId: npcUserId })).toEqual({
        success: true,
      });
      expect(await executeMuteUser(agent, { userId: npcUserId })).toEqual({
        success: true,
      });
      expect(await muteRowsFor(npcUserId)).toHaveLength(1);
    });

    it(selfCase, async () => {
      await expect(
        executeMuteUser(agent, { userId: agentUserId })
      ).rejects.toThrow('Cannot mute yourself');
      expect(await muteRowsFor(agentUserId)).toHaveLength(0);
    });
  });
} else {
  it('runs the mute cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-mute-unknown-user',
      file: 'packages/testing/integration/mcp-mute-unknown-user.integration.test.ts',
      cases: [unknownCase, realCase, repeatCase, selfCase].map(
        (name) => `${suite} > ${name}`
      ),
    });
  }, 300_000);
}
