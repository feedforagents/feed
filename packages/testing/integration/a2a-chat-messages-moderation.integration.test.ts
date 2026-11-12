/**
 * messaging.get_chat_messages against a real database: for a group chat,
 * the A2A message list must apply the same viewer moderation rule as every
 * other reading surface.
 *
 * The same viewer rule the home feeds, the post list, the comment thread
 * and the notification list apply — and the rule the A2A executor itself
 * already applies to messaging.get_notifications in this codebase — is
 * what PRD §12 retains for group chat reads. The web group chat history
 * (GET /api/chats/[id]) does not apply it yet; that parity is tracked in
 * #1710, so this suite asserts the A2A surface only.
 * The A2A getChatMessages applied no filter at all, so an agent reading a
 * group chat on the viewer's behalf received every message from authors
 * the viewer had blocked or muted, including their message text.
 *
 * Scope: group chats only, mirroring the rule the other reading surfaces
 * apply. DM history is
 * a separate surface (a block already prevents creating a DM and sending
 * in one) and is asserted unchanged here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  eq,
  inArray,
  messages,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type ChatMessagesResult = {
  messages: Array<{ id: string; content: string; senderId: string }>;
};

let viewerId: string;
let normalAuthorId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockedByAuthorId: string;

let groupChatId: string;
let dmChatId: string;

let normalMsg1: string;
let blockedMsg: string;
let mutedMsg: string;
let blockedByMsg: string;
let viewerMsg: string;
let normalMsg2: string;
let dmMsgFromBlocked: string;

// Rows this suite owns. Each array is populated only from the RETURNING
// result of a successful insert, never from the proposed ids: if an insert
// fails or an id collides with a pre-existing row, teardown must not delete
// a row this suite did not create.
const allUserIds: string[] = [];
const allChatIds: string[] = [];
const allMessageIds: string[] = [];
const allParticipantIds: string[] = [];
const allBlockIds: string[] = [];
const allMuteIds: string[] = [];

// Delete only owned rows, children before parents, so a partial setup
// (or a colliding id) can never wipe pre-existing rows. Idempotent: safe
// to run again after a test already called it.
async function cleanupOwned() {
  await db.delete(messages).where(inArray(messages.id, allMessageIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.id, allParticipantIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(userBlocks).where(inArray(userBlocks.id, allBlockIds));
  await db.delete(userMutes).where(inArray(userMutes.id, allMuteIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
}

async function fetchChatMessages(
  chatId: string,
  params: Record<string, number> = {}
) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'messaging.get_chat_messages',
    { chatId, limit: 50, offset: 0, ...params },
    viewerId
  )) as unknown as ChatMessagesResult;
  return result;
}

beforeAll(async () => {
  const ids = await Promise.all(
    Array.from({ length: 20 }, () => generateSnowflakeId())
  );
  [
    viewerId,
    normalAuthorId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    groupChatId,
    dmChatId,
    normalMsg1,
    blockedMsg,
    mutedMsg,
    blockedByMsg,
    viewerMsg,
    normalMsg2,
    dmMsgFromBlocked,
  ] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const [blockRowA, blockRowB, muteRow] = [
    ids[14] as string,
    ids[15] as string,
    ids[16] as string,
  ];
  const participantIds = await Promise.all(
    Array.from({ length: 5 }, () => generateSnowflakeId())
  );

  const now = new Date();
  const at = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000);

  const createdUsers = await db
    .insert(users)
    .values(
      [
        viewerId,
        normalAuthorId,
        blockedAuthorId,
        mutedAuthorId,
        blockedByAuthorId,
      ].map((id, i) => ({
        id,
        username: `g37-${i}-${id}`,
        displayName: `G37 Fixture ${i}`,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });
  allUserIds.push(...createdUsers.map((row) => row.id));

  // The viewer blocked one author, muted another, and is blocked by a
  // third — the three sets every reading surface excludes at read time.
  const createdBlocks = await db
    .insert(userBlocks)
    .values([
      { id: blockRowA, blockerId: viewerId, blockedId: blockedAuthorId },
      { id: blockRowB, blockerId: blockedByAuthorId, blockedId: viewerId },
    ])
    .returning({ id: userBlocks.id });
  allBlockIds.push(...createdBlocks.map((row) => row.id));
  const createdMutes = await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: viewerId, mutedId: mutedAuthorId }])
    .returning({ id: userMutes.id });
  allMuteIds.push(...createdMutes.map((row) => row.id));

  const createdChats = await db
    .insert(chats)
    .values([
      {
        id: groupChatId,
        name: 'G37 group',
        isGroup: true,
        createdBy: viewerId,
        updatedAt: now,
      },
      {
        id: dmChatId,
        name: null,
        isGroup: false,
        createdBy: viewerId,
        updatedAt: now,
      },
    ])
    .returning({ id: chats.id });
  allChatIds.push(...createdChats.map((row) => row.id));

  const dmParticipantIds = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const createdParticipants = await db
    .insert(chatParticipants)
    .values([
      ...[
        viewerId,
        normalAuthorId,
        blockedAuthorId,
        mutedAuthorId,
        blockedByAuthorId,
      ].map((userId, i) => ({
        id: participantIds[i] as string,
        chatId: groupChatId,
        userId,
        isActive: true,
      })),
      {
        id: dmParticipantIds[0] as string,
        chatId: dmChatId,
        userId: viewerId,
        isActive: true,
      },
      {
        id: dmParticipantIds[1] as string,
        chatId: dmChatId,
        userId: blockedAuthorId,
        isActive: true,
      },
    ])
    .returning({ id: chatParticipants.id });
  allParticipantIds.push(...createdParticipants.map((row) => row.id));

  const createdMessages = await db
    .insert(messages)
    .values([
      {
        id: normalMsg1,
        chatId: groupChatId,
        senderId: normalAuthorId,
        content: 'normal message one',
        type: 'user',
        createdAt: at(50),
      },
      {
        id: blockedMsg,
        chatId: groupChatId,
        senderId: blockedAuthorId,
        content: 'blocked author message that must stay hidden',
        type: 'user',
        createdAt: at(40),
      },
      {
        id: mutedMsg,
        chatId: groupChatId,
        senderId: mutedAuthorId,
        content: 'muted author message that must stay hidden',
        type: 'user',
        createdAt: at(30),
      },
      {
        id: blockedByMsg,
        chatId: groupChatId,
        senderId: blockedByAuthorId,
        content: 'blocking author message that must stay hidden',
        type: 'user',
        createdAt: at(20),
      },
      {
        id: viewerMsg,
        chatId: groupChatId,
        senderId: viewerId,
        content: 'viewer own message',
        type: 'user',
        createdAt: at(10),
      },
      {
        id: normalMsg2,
        chatId: groupChatId,
        senderId: normalAuthorId,
        content: 'normal message two',
        type: 'user',
        createdAt: at(5),
      },
      {
        id: dmMsgFromBlocked,
        chatId: dmChatId,
        senderId: blockedAuthorId,
        content: 'dm message from blocked author',
        type: 'user',
        createdAt: at(10),
      },
    ])
    .returning({ id: messages.id });
  allMessageIds.push(...createdMessages.map((row) => row.id));
});

afterAll(async () => {
  await cleanupOwned();
});

describe('A2A messaging.get_chat_messages moderation filter', () => {
  it('hides group messages from blocked, muted, and blocking authors', async () => {
    const { messages: list } = await fetchChatMessages(groupChatId);
    const ids = list.map((m) => m.id);
    expect(ids).toContain(normalMsg1);
    expect(ids).toContain(normalMsg2);
    expect(ids).toContain(viewerMsg);
    expect(ids).not.toContain(blockedMsg);
    expect(ids).not.toContain(mutedMsg);
    expect(ids).not.toContain(blockedByMsg);
    expect(JSON.stringify(list)).not.toContain('must stay hidden');
  });

  it('applies moderation before limit and offset', async () => {
    const firstPage = await fetchChatMessages(groupChatId, { limit: 2 });
    expect(firstPage.messages.map((m) => m.id)).toEqual([
      normalMsg2,
      viewerMsg,
    ]);
    const secondPage = await fetchChatMessages(groupChatId, {
      limit: 2,
      offset: 2,
    });
    expect(secondPage.messages.map((m) => m.id)).toEqual([normalMsg1]);
  });

  it('leaves DM history unchanged', async () => {
    const { messages: list } = await fetchChatMessages(dmChatId);
    expect(list.map((m) => m.id)).toEqual([dmMsgFromBlocked]);
  });
});

describe('A2A chat message moderation edge cases', () => {
  it('still denies non-participants', async () => {
    await expect(
      FeedAgentExecutor.executeDirectly(
        'messaging.get_chat_messages',
        { chatId: dmChatId, limit: 50, offset: 0 },
        normalAuthorId
      )
    ).rejects.toThrow('Chat not found or access denied');
  });

  it('refreshes moderation immediately after unblocking and unmuting', async () => {
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, allUserIds));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockedId, allUserIds));
    await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
    const { messages: list } = await fetchChatMessages(groupChatId);
    expect(list.map((m) => m.id)).toEqual([
      normalMsg2,
      viewerMsg,
      blockedByMsg,
      mutedMsg,
      blockedMsg,
      normalMsg1,
    ]);
  });

  it('cleanup removes only rows this suite created', async () => {
    // Pre-existing rows this suite did not create — including moderation
    // rows between fixture users, the case a partial setup or an id
    // collision would have wiped when teardown deleted by chat/user id.
    // None of these ids are in the owned arrays, so the shared cleanup
    // must leave every one of them untouched.
    const sentinelUserId = await generateSnowflakeId();
    const sentinelChatId = await generateSnowflakeId();
    const sentinelMsgId = await generateSnowflakeId();
    const sentinelParticipantId = await generateSnowflakeId();
    const sentinelBlockId = await generateSnowflakeId();
    const sentinelMuteId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(users).values({
      id: sentinelUserId,
      username: `g37-sentinel-${sentinelUserId}`,
      displayName: 'G37 Sentinel',
      updatedAt: now,
    });
    await db.insert(chats).values({
      id: sentinelChatId,
      name: 'G37 sentinel',
      isGroup: true,
      createdBy: sentinelUserId,
      updatedAt: now,
    });
    await db.insert(chatParticipants).values({
      id: sentinelParticipantId,
      chatId: sentinelChatId,
      userId: sentinelUserId,
      isActive: true,
    });
    await db.insert(messages).values({
      id: sentinelMsgId,
      chatId: sentinelChatId,
      senderId: sentinelUserId,
      content: 'sentinel message',
      type: 'user',
      createdAt: now,
    });
    await db.insert(userBlocks).values({
      id: sentinelBlockId,
      blockerId: viewerId,
      blockedId: normalAuthorId,
    });
    await db.insert(userMutes).values({
      id: sentinelMuteId,
      muterId: viewerId,
      mutedId: normalAuthorId,
    });

    await cleanupOwned();

    // Owned rows are gone...
    expect(
      await db
        .select()
        .from(messages)
        .where(inArray(messages.id, allMessageIds))
    ).toEqual([]);
    expect(
      await db.select().from(users).where(inArray(users.id, allUserIds))
    ).toEqual([]);
    // ...but every pre-existing row survives.
    expect(
      await db.select().from(users).where(eq(users.id, sentinelUserId))
    ).toHaveLength(1);
    expect(
      await db.select().from(chats).where(eq(chats.id, sentinelChatId))
    ).toHaveLength(1);
    expect(
      await db.select().from(messages).where(eq(messages.id, sentinelMsgId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.id, sentinelParticipantId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(userBlocks)
        .where(eq(userBlocks.id, sentinelBlockId))
    ).toHaveLength(1);
    expect(
      await db.select().from(userMutes).where(eq(userMutes.id, sentinelMuteId))
    ).toHaveLength(1);

    // Remove the sentinel rows this test itself created.
    await db.delete(messages).where(eq(messages.id, sentinelMsgId));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.id, sentinelParticipantId));
    await db.delete(chats).where(eq(chats.id, sentinelChatId));
    await db.delete(userBlocks).where(eq(userBlocks.id, sentinelBlockId));
    await db.delete(userMutes).where(eq(userMutes.id, sentinelMuteId));
    await db.delete(users).where(eq(users.id, sentinelUserId));
  });
});
