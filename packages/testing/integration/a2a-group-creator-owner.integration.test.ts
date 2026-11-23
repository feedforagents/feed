import { describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'A2A group creator ownership';
const ownershipCase =
  'creates an active owner, keeps the invited member, and enforces the owner leave guard';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { FeedAgentExecutor } = await import('@feed/a2a');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { and, chatParticipants, db, eq, groupMembers, groups, users } =
    await import('@feed/db');

  describe(suite, () => {
    it(ownershipCase, async () => {
      const [creatorId, invitedId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);
      const updatedAt = new Date();
      await db.insert(users).values([
        { id: creatorId, username: `a2a-owner-${creatorId}`, updatedAt },
        { id: invitedId, username: `a2a-member-${invitedId}`, updatedAt },
      ]);

      const { group } = (await FeedAgentExecutor.executeDirectly(
        'messaging.create_group',
        { name: 'Group ownership fixture', memberIds: [invitedId] },
        creatorId
      )) as { group: { id: string; chatId: string } };
      const [created] = await db
        .select({ ownerId: groups.ownerId, createdById: groups.createdById })
        .from(groups)
        .where(eq(groups.id, group.id));
      expect(created).toEqual({ ownerId: creatorId, createdById: creatorId });

      async function membership(userId: string) {
        const [member] = await db
          .select({ role: groupMembers.role, isActive: groupMembers.isActive })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, group.id),
              eq(groupMembers.userId, userId)
            )
          );
        return member;
      }

      expect(await membership(creatorId)).toEqual({
        role: 'owner',
        isActive: true,
      });
      expect(await membership(invitedId)).toEqual({
        role: 'member',
        isActive: true,
      });
      await expect(
        FeedAgentExecutor.executeDirectly(
          'messaging.leave_chat',
          { chatId: group.chatId },
          creatorId
        )
      ).rejects.toThrow('Group owners cannot leave');

      const [participant] = await db
        .select({ isActive: chatParticipants.isActive })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, group.chatId),
            eq(chatParticipants.userId, creatorId)
          )
        );
      expect(participant?.isActive).toBe(true);
      expect(await membership(creatorId)).toEqual({
        role: 'owner',
        isActive: true,
      });
    });
  });
} else {
  it('runs the group ownership case on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'a2a-group-creator-owner',
      file: 'packages/testing/integration/a2a-group-creator-owner.integration.test.ts',
      cases: [`${suite} > ${ownershipCase}`],
    });
  }, 300_000);
}
