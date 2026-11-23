/** MCP group creation membership parity. PRD §§8.1/9.5/12, MVP Phases 3/5. */
import { expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const unknownCase = 'does not add a user who does not exist';
const bannedCase = 'does not add a banned user';
const validCase = 'adds a real, unbanned member';
const mixedCase = 'adds only the valid member from a mixed list';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks group membership in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-create-group-member-validation',
      file: 'packages/testing/integration/mcp-create-group-member-validation.integration.test.ts',
      cases: [unknownCase, bannedCase, validCase, mixedCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { chatParticipants, db, eq, groupMembers, users } = await import(
    '@feed/db'
  );
  const { executeCreateGroup } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  async function createUser(isBanned = false) {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      username: `f184_${id.slice(-10)}`,
      isActor: false,
      isBanned,
      updatedAt: new Date(),
    });
    return id;
  }

  async function expectMembership(
    creator: string,
    requestedIds: string[],
    validMemberIds: string[]
  ) {
    const result = await executeCreateGroup(
      { agentId: creator, userId: creator },
      { name: 'Group membership fixture', memberIds: requestedIds }
    );
    expect(result.success).toBe(true);
    const chat = await db.query.chats.findFirst({
      where: (row, operators) => operators.eq(row.id, result.chatId),
    });
    if (!chat?.groupId) throw new Error('Created chat has no group');

    const [participants, members] = await Promise.all([
      db
        .select({ userId: chatParticipants.userId })
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, result.chatId)),
      db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, chat.groupId)),
    ]);
    const expectedIds = [creator, ...validMemberIds].sort();
    expect(participants.map(({ userId }) => userId).sort()).toEqual(
      expectedIds
    );
    expect(members.map(({ userId }) => userId).sort()).toEqual(expectedIds);
  }

  test(unknownCase, async () => {
    await expectMembership(await createUser(), [crypto.randomUUID()], []);
  });

  test(bannedCase, async () => {
    const creator = await createUser();
    const banned = await createUser(true);
    await expectMembership(creator, [banned], []);
  });

  test(validCase, async () => {
    const creator = await createUser();
    const member = await createUser();
    await expectMembership(creator, [member], [member]);
  });

  test(mixedCase, async () => {
    const creator = await createUser();
    const member = await createUser();
    const banned = await createUser(true);
    await expectMembership(
      creator,
      [member, banned, crypto.randomUUID(), creator, member],
      [member]
    );
  });
}
