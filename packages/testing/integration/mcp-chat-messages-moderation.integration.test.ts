/**
 * MCP get_chat_messages against a real database: for a group chat, the
 * MCP message list must apply the same viewer moderation rule as every
 * other reading surface.
 *
 * The web group chat history (GET /api/chats/[id]) and the A2A
 * messaging.get_chat_messages both exclude authors the viewer blocked or
 * muted, and authors who blocked the viewer, at the query level — the
 * same rule the home feeds, the post list, the comment thread and the
 * notification list apply, and the rule this package's own search_agents
 * handler already applies to its results. The MCP executeGetChatMessages
 * applied no filter at all, so an MCP client reading a group chat on the
 * viewer's behalf received every message the web and A2A surfaces hide,
 * including the text of blocked and muted members.
 *
 * Scope: group chats only, mirroring the web/A2A history rule. DM history
 * is a separate surface (a block already prevents creating a DM and
 * sending in one) and is asserted unchanged here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  inArray,
  messages,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetChatMessages } from '../../mcp/src/handlers/tool-handlers';

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

const allUserIds: string[] = [];
const allChatIds: string[] = [];
const allMessageIds: string[] = [];

async function fetchChatMessages(
  chatId: string,
  params: Record<string, number> = {}
) {
  return executeGetChatMessages(
    { agentId: 'agent', userId: viewerId },
    { chatId, limit: 50, offset: 0, ...params }
  );
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

  allUserIds.push(
    viewerId,
    normalAuthorId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId
  );
  allChatIds.push(groupChatId, dmChatId);
  allMessageIds.push(
    normalMsg1,
    blockedMsg,
    mutedMsg,
    blockedByMsg,
    viewerMsg,
    normalMsg2,
    dmMsgFromBlocked
  );

  const now = new Date();
  const at = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000);

  await db.insert(users).values(
    allUserIds.map((id, i) => ({
      id,
      username: `g39-${i}-${id}`,
      displayName: `G39 Fixture ${i}`,
      updatedAt: now,
    }))
  );

  await db.insert(userBlocks).values([
    { id: blockRowA, blockerId: viewerId, blockedId: blockedAuthorId },
    { id: blockRowB, blockerId: blockedByAuthorId, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: viewerId, mutedId: mutedAuthorId }]);

  await db.insert(chats).values([
    {
      id: groupChatId,
      name: 'G39 group',
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
  ]);

  await db.insert(chatParticipants).values([
    ...allUserIds.map((userId, i) => ({
      id: participantIds[i] as string,
      chatId: groupChatId,
      userId,
      isActive: true,
    })),
    {
      id: await generateSnowflakeId(),
      chatId: dmChatId,
      userId: viewerId,
      isActive: true,
    },
    {
      id: await generateSnowflakeId(),
      chatId: dmChatId,
      userId: blockedAuthorId,
      isActive: true,
    },
  ]);

  await db.insert(messages).values([
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
  ]);
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.id, allMessageIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, allChatIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('MCP get_chat_messages moderation filter', () => {
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

  it('still denies non-participants', async () => {
    await expect(
      executeGetChatMessages(
        { agentId: 'agent', userId: normalAuthorId },
        { chatId: dmChatId, limit: 50, offset: 0 }
      )
    ).rejects.toThrow('Unauthorized');
  });
});
