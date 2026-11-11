/**
 * Group invite accept: a user banned after the invite was sent must not be
 * able to turn the pending invite into group membership / chat access.
 *
 * Both invite-creating entry points refuse banned users up front
 * (POST /api/groups filters `isBanned: false`; POST
 * /api/groups/[groupId]/members returns 400 "Cannot add banned users to
 * groups"), and the ban write itself only flips `users.isBanned` — it does
 * not touch pending invites. Accept is the step that actually grants
 * membership, so it must re-check the ban at grant time.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { acceptGroupInvite, declineGroupInvite } from '@feed/api';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupInvites,
  groupMembers,
  groups,
  inArray,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const created = {
  users: [] as string[],
  groups: [] as string[],
  chats: [] as string[],
  invites: [] as string[],
};

async function createUser(options?: { isBanned?: boolean }): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `invb_${id.slice(-10)}`,
    isActor: false,
    isBanned: options?.isBanned ?? false,
    updatedAt: new Date(),
  });
  created.users.push(id);
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
  created.groups.push(groupId);
  created.chats.push(chatId);
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
  created.invites.push(id);
  return id;
}

async function banUser(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ isBanned: true, bannedAt: new Date() })
    .where(eq(users.id, userId));
}

describe('group invite accept — banned invitee', () => {
  afterAll(async () => {
    await db
      .delete(groupMembers)
      .where(inArray(groupMembers.groupId, created.groups));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, created.chats));
    await db
      .delete(groupInvites)
      .where(inArray(groupInvites.id, created.invites));
    await db.delete(chats).where(inArray(chats.id, created.chats));
    await db.delete(groups).where(inArray(groups.id, created.groups));
    await db.delete(users).where(inArray(users.id, created.users));

    const [leftoverUsers, leftoverInvites] = await Promise.all([
      db.select().from(users).where(inArray(users.id, created.users)),
      db
        .select()
        .from(groupInvites)
        .where(inArray(groupInvites.id, created.invites)),
    ]);
    expect(leftoverUsers).toHaveLength(0);
    expect(leftoverInvites).toHaveLength(0);
  });

  it('refuses accept when the invitee was banned after the invite was sent', async () => {
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
  });

  it('still accepts for an invitee who is not banned (control)', async () => {
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
  });

  it('still lets a banned invitee decline the invite', async () => {
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
});
