/** Group invite acceptance parity. PRD §§8.1/9.5/12, MVP Phases 3/5. */
import { expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const bannedCase =
  'refuses accept when the invitee was banned after the invite was sent';
const validCase = 'still accepts for an invitee who is not banned';
const declineCase = 'still lets a banned invitee decline the invite';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks group invite acceptance in disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'group-invite-accept-banned',
      file: 'packages/testing/integration/group-invite-accept-banned.integration.test.ts',
      cases: [bannedCase, validCase, declineCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { acceptGroupInvite, declineGroupInvite } = await import('@feed/api');
  const {
    and,
    chatParticipants,
    chats,
    db,
    eq,
    groupInvites,
    groupMembers,
    groups,
    messages,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');

  async function createUser(options?: { isBanned?: boolean }): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `invb_${id.slice(-10)}`,
      isActor: false,
      isBanned: options?.isBanned ?? false,
      updatedAt: new Date(),
    });
    return id;
  }

  async function createGroupWithChat(ownerId: string): Promise<{
    groupId: string;
    chatId: string;
  }> {
    const groupId = await generateSnowflakeId();
    const chatId = await generateSnowflakeId();
    await db.insert(groups).values({
      id: groupId,
      name: `Invite ban test ${groupId}`,
      type: 'user',
      ownerId,
      createdById: ownerId,
      updatedAt: new Date(),
    });
    await db.insert(chats).values({
      id: chatId,
      isGroup: true,
      groupId,
      updatedAt: new Date(),
    });
    return { groupId, chatId };
  }

  async function createInvite(
    groupId: string,
    invitedUserId: string,
    invitedBy: string
  ): Promise<string> {
    const id = await generateSnowflakeId();
    await db
      .insert(groupInvites)
      .values({ id, groupId, invitedUserId, invitedBy });
    return id;
  }

  async function banUser(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ isBanned: true, bannedAt: new Date() })
      .where(eq(users.id, userId));
  }

  function chatMessages(chatId: string) {
    return db.select().from(messages).where(eq(messages.chatId, chatId));
  }

  test(bannedCase, async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const { groupId, chatId } = await createGroupWithChat(owner);
    const inviteId = await createInvite(groupId, invitee, owner);

    // The ban lands after the invite was created; the ban write does not
    // touch pending invites, so the invite is still live.
    await banUser(invitee);

    let thrown: unknown = null;
    try {
      await acceptGroupInvite(invitee, inviteId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { statusCode?: number }).statusCode).toBe(400);
    expect((thrown as Error).message).toContain('banned');

    // The refusal must not consume the invite or grant anything.
    const [invite] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.id, inviteId));
    expect(invite?.status).toBe('pending');

    const memberships = await db
      .select()
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, invitee))
      );
    expect(memberships).toHaveLength(0);

    const participants = await db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, invitee)
        )
      );
    expect(participants).toHaveLength(0);
    expect(await chatMessages(chatId)).toHaveLength(0);
  });

  test(validCase, async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const { groupId, chatId } = await createGroupWithChat(owner);
    const inviteId = await createInvite(groupId, invitee, owner);

    const result = await acceptGroupInvite(invitee, inviteId);
    expect(result.groupId).toBe(groupId);
    expect(result.chatId).toBe(chatId);

    const [invite] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.id, inviteId));
    expect(invite?.status).toBe('accepted');

    const [membership] = await db
      .select()
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, invitee))
      );
    expect(membership?.isActive).toBe(true);

    const [participant] = await db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, invitee)
        )
      );
    expect(participant?.isActive).toBe(true);
    const joinMessages = await chatMessages(chatId);
    expect(joinMessages).toHaveLength(1);
    expect(joinMessages[0]).toMatchObject({
      senderId: 'system',
      type: 'system',
    });
  });

  test(declineCase, async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const { groupId } = await createGroupWithChat(owner);
    const inviteId = await createInvite(groupId, invitee, owner);
    await banUser(invitee);

    await declineGroupInvite(invitee, inviteId);

    const [invite] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.id, inviteId));
    expect(invite?.status).toBe('declined');

    const memberships = await db
      .select()
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, invitee))
      );
    expect(memberships).toHaveLength(0);
  });
}
