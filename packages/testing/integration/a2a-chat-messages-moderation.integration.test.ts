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
  and,
  chatParticipants,
  chats,
  db,
  eq,
  gameOnboarding,
  inArray,
  messageReactions,
  messages,
  sql,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import { fixtureRowJson } from './helpers/fixture-row-json';

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

// Proposed fixture IDs do not establish ownership; only RETURNING rows do.
const fixtureUserIds: string[] = [];

function ownership() {
  return {
    onboarding: new Map<string, typeof gameOnboarding.$inferSelect>(),
    pnl: new Map<string, typeof userPnLSnapshots.$inferSelect>(),
    whitelist: new Map<string, typeof whitelist.$inferSelect>(),
    configs: new Map<string, typeof whitelistConfig.$inferSelect>(),
    users: new Map<string, typeof users.$inferSelect>(),
    chats: new Map<string, typeof chats.$inferSelect>(),
    participants: new Map<string, typeof chatParticipants.$inferSelect>(),
    messages: new Map<string, typeof messages.$inferSelect>(),
    blocks: new Map<string, typeof userBlocks.$inferSelect>(),
    mutes: new Map<string, typeof userMutes.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(users).values(values).returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Users RETURNING');
  return rows;
}

async function insertChats(
  values: Array<typeof chats.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(chats).values(values).returning();
  for (const row of rows) receipt.chats.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Chats RETURNING');
  return rows;
}

async function insertParticipants(
  values: Array<typeof chatParticipants.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(chatParticipants).values(values).returning();
  for (const row of rows) receipt.participants.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Participants RETURNING');
  return rows;
}

async function insertMessages(
  values: Array<typeof messages.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(messages).values(values).returning();
  for (const row of rows) receipt.messages.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Messages RETURNING');
  return rows;
}

async function insertBlocks(
  values: Array<typeof userBlocks.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userBlocks).values(values).returning();
  for (const row of rows) receipt.blocks.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Blocks RETURNING');
  return rows;
}

async function insertMutes(
  values: Array<typeof userMutes.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userMutes).values(values).returning();
  for (const row of rows) receipt.mutes.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Mutes RETURNING');
  return rows;
}

async function insertOnboarding(
  values: Array<typeof gameOnboarding.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(gameOnboarding).values(values).returning();
  for (const row of rows) receipt.onboarding.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete GameOnboarding RETURNING');
  return rows;
}

async function insertPnL(
  values: Array<typeof userPnLSnapshots.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(userPnLSnapshots).values(values).returning();
  for (const row of rows) receipt.pnl.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserPnLSnapshot RETURNING');
  return rows;
}

async function insertWhitelist(
  values: Array<typeof whitelist.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(whitelist).values(values).returning();
  for (const row of rows) receipt.whitelist.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Whitelist RETURNING');
  return rows;
}

async function insertConfigs(
  values: Array<typeof whitelistConfig.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(whitelistConfig).values(values).returning();
  for (const row of rows) receipt.configs.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete WhitelistConfig RETURNING');
  return rows;
}

async function removeRows<Row extends { id: string }>(
  rows: Map<string, Row>,
  erase: (row: Row) => Promise<void>,
  read: (id: string) => Promise<Array<{ id: string }>>
) {
  return Promise.allSettled(
    [...rows.values()].map(async (row) => {
      await erase(row);
      if ((await read(row.id)).length) {
        throw new Error(`Owned fixture row remains: ${row.id}`);
      }
      rows.delete(row.id);
    })
  );
}

function assertCleanupSucceeded(results: PromiseSettledResult<void>[]) {
  const failures = results.flatMap((result) =>
    result.status === 'rejected'
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error('Unexpected cleanup failure'),
        ]
      : []
  );
  if (failures.length) {
    throw new AggregateError(failures, 'Owned chat fixture cleanup incomplete');
  }
}

async function removeBlocks(receipt: Ownership) {
  return removeRows(
    receipt.blocks,
    async (row) => {
      await db
        .delete(userBlocks)
        .where(
          and(
            eq(userBlocks.id, row.id),
            sql`to_jsonb(${userBlocks}) = to_jsonb(jsonb_populate_record(NULL::"UserBlock", ${JSON.stringify(row)}::jsonb))`
          )
        );
    },
    async (id) =>
      db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(eq(userBlocks.id, id))
  );
}

async function removeMutes(receipt: Ownership) {
  return removeRows(
    receipt.mutes,
    async (row) => {
      await db
        .delete(userMutes)
        .where(
          and(
            eq(userMutes.id, row.id),
            sql`to_jsonb(${userMutes}) = to_jsonb(jsonb_populate_record(NULL::"UserMute", ${JSON.stringify(row)}::jsonb))`
          )
        );
    },
    async (id) =>
      db
        .select({ id: userMutes.id })
        .from(userMutes)
        .where(eq(userMutes.id, id))
  );
}

async function cleanup(receipt: Ownership) {
  // Attempt every owned child before its parents. A changed or still-referenced
  // tuple stays in place and fails cleanup; never broaden a delete to make it pass.
  const results = [
    ...(await removeRows(
      receipt.messages,
      async (row) => {
        await db
          .delete(messages)
          .where(
            and(
              eq(messages.id, row.id),
              sql`to_jsonb(${messages}) = to_jsonb(jsonb_populate_record(NULL::"Message", ${JSON.stringify(row)}::jsonb))`,
              sql`NOT EXISTS (SELECT 1 FROM ${messageReactions} WHERE ${messageReactions.messageId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM "Message" AS reply WHERE reply."replyToMessageId" = ${row.id} AND reply.id <> ${row.id})`
            )
          );
      },
      async (id) =>
        db.select({ id: messages.id }).from(messages).where(eq(messages.id, id))
    )),
    ...(await removeRows(
      receipt.participants,
      async (row) => {
        await db
          .delete(chatParticipants)
          .where(
            and(
              eq(chatParticipants.id, row.id),
              sql`to_jsonb(${chatParticipants}) = to_jsonb(jsonb_populate_record(NULL::"ChatParticipant", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: chatParticipants.id })
          .from(chatParticipants)
          .where(eq(chatParticipants.id, id))
    )),
    ...(await removeRows(
      receipt.chats,
      async (row) => {
        await db
          .delete(chats)
          .where(
            and(
              eq(chats.id, row.id),
              sql`to_jsonb(${chats}) = to_jsonb(jsonb_populate_record(NULL::"Chat", ${fixtureRowJson('Chat', row)}::jsonb))`,
              sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.chatId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${chatParticipants} WHERE ${chatParticipants.chatId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${messageReactions} WHERE ${messageReactions.chatId} = ${row.id})`
            )
          );
      },
      async (id) =>
        db.select({ id: chats.id }).from(chats).where(eq(chats.id, id))
    )),
    ...(await removeBlocks(receipt)),
    ...(await removeMutes(receipt)),
    ...(await removeRows(
      receipt.onboarding,
      async (row) => {
        await db
          .delete(gameOnboarding)
          .where(
            and(
              eq(gameOnboarding.id, row.id),
              sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, id))
    )),
    ...(await removeRows(
      receipt.pnl,
      async (row) => {
        await db
          .delete(userPnLSnapshots)
          .where(
            and(
              eq(userPnLSnapshots.id, row.id),
              sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: userPnLSnapshots.id })
          .from(userPnLSnapshots)
          .where(eq(userPnLSnapshots.id, id))
    )),
    ...(await removeRows(
      receipt.whitelist,
      async (row) => {
        await db
          .delete(whitelist)
          .where(
            and(
              eq(whitelist.id, row.id),
              sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(eq(whitelist.id, id))
    )),
    ...(await removeRows(
      receipt.configs,
      async (row) => {
        await db
          .delete(whitelistConfig)
          .where(
            and(
              eq(whitelistConfig.id, row.id),
              sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: whitelistConfig.id })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.id, id))
    )),
    ...(await removeRows(
      receipt.users,
      async (row) => {
        await db.delete(users).where(
          and(
            eq(users.id, row.id),
            sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${fixtureRowJson('User', row)}::jsonb))`,
            // Baseline User FKs can otherwise delete or null non-owned children.
            sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.grantedBy} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`,

            sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.senderId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${chatParticipants} WHERE ${chatParticipants.userId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${messageReactions} WHERE ${messageReactions.userId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${chats} WHERE ${chats.createdBy} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE ${userBlocks.blockerId} = ${row.id} OR ${userBlocks.blockedId} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${userMutes} WHERE ${userMutes.muterId} = ${row.id} OR ${userMutes.mutedId} = ${row.id})`
          )
        );
      },
      async (id) =>
        db.select({ id: users.id }).from(users).where(eq(users.id, id))
    )),
  ];
  assertCleanupSucceeded(results);
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

  fixtureUserIds.push(
    viewerId,
    normalAuthorId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId
  );

  const now = new Date();
  const at = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000);

  await insertUsers(
    fixtureUserIds.map((id, i) => ({
      id,
      username: `g37-${i}-${id}`,
      displayName: `G37 Fixture ${i}`,
      createdAt: now,
      updatedAt: now,
    }))
  );

  // The viewer blocked one author, muted another, and is blocked by a
  // third — the three sets every reading surface excludes at read time.
  await insertBlocks([
    {
      id: blockRowA,
      blockerId: viewerId,
      blockedId: blockedAuthorId,
      createdAt: now,
    },
    {
      id: blockRowB,
      blockerId: blockedByAuthorId,
      blockedId: viewerId,
      createdAt: now,
    },
  ]);
  await insertMutes([
    { id: muteRow, muterId: viewerId, mutedId: mutedAuthorId, createdAt: now },
  ]);

  await insertChats([
    {
      id: groupChatId,
      name: 'G37 group',
      isGroup: true,
      createdBy: viewerId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: dmChatId,
      name: null,
      isGroup: false,
      createdBy: viewerId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await insertParticipants([
    ...fixtureUserIds.map((userId, i) => ({
      id: participantIds[i] as string,
      chatId: groupChatId,
      userId,
      joinedAt: now,
      isActive: true,
    })),
    {
      id: await generateSnowflakeId(),
      chatId: dmChatId,
      userId: viewerId,
      joinedAt: now,
      isActive: true,
    },
    {
      id: await generateSnowflakeId(),
      chatId: dmChatId,
      userId: blockedAuthorId,
      joinedAt: now,
      isActive: true,
    },
  ]);

  await insertMessages([
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
  await cleanup(owned);
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
    assertCleanupSucceeded([
      ...(await removeBlocks(owned)),
      ...(await removeMutes(owned)),
    ]);
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
});

describe('authored cleanup ownership control', () => {
  it('cleanup removes only rows this suite created', async () => {
    const controls = ownership();
    const originalUserIds = [...owned.users.keys()];
    const originalMessageIds = [...owned.messages.keys()];
    const viewer = owned.users.get(viewerId);
    const normalAuthor = owned.users.get(normalAuthorId);
    if (!viewer || !normalAuthor)
      throw new Error('Missing acquired main users');
    const now = new Date();
    try {
      const [user] = await insertUsers(
        [
          {
            id: await generateSnowflakeId(),
            username: `g37-sentinel-${crypto.randomUUID()}`,
            displayName: 'G37 Sentinel',
            createdAt: now,
            updatedAt: now,
          },
        ],
        controls
      );
      if (!user) throw new Error('Missing acquired sentinel user');
      const [chat] = await insertChats(
        [
          {
            id: await generateSnowflakeId(),
            name: 'G37 sentinel',
            isGroup: true,
            createdBy: user.id,
            createdAt: now,
            updatedAt: now,
          },
        ],
        controls
      );
      if (!chat) throw new Error('Missing acquired sentinel chat');
      const [participant] = await insertParticipants(
        [
          {
            id: await generateSnowflakeId(),
            chatId: chat.id,
            userId: user.id,
            joinedAt: now,
            isActive: true,
          },
        ],
        controls
      );
      const [message] = await insertMessages(
        [
          {
            id: await generateSnowflakeId(),
            chatId: chat.id,
            senderId: user.id,
            content: 'sentinel message',
            type: 'user',
            createdAt: now,
          },
        ],
        controls
      );
      const [block] = await insertBlocks(
        [
          {
            id: await generateSnowflakeId(),
            blockerId: viewerId,
            blockedId: normalAuthorId,
            createdAt: now,
          },
        ],
        controls
      );
      const [mute] = await insertMutes(
        [
          {
            id: await generateSnowflakeId(),
            muterId: viewerId,
            mutedId: normalAuthorId,
            createdAt: now,
          },
        ],
        controls
      );
      if (!participant || !message || !block || !mute)
        throw new Error('Missing acquired sentinel child');

      // The separate control receipt owns these references. Main cleanup may
      // remove its children, but must retain referenced User parents.
      await expect(cleanup(owned)).rejects.toThrow(
        'Owned chat fixture cleanup incomplete'
      );
      expect(
        await db
          .select()
          .from(messages)
          .where(inArray(messages.id, originalMessageIds))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, viewerId))
      ).toEqual([viewer]);
      expect(
        await db.select().from(users).where(eq(users.id, normalAuthorId))
      ).toEqual([normalAuthor]);
      expect(
        await db.select().from(users).where(eq(users.id, user.id))
      ).toEqual([user]);
      expect(
        await db.select().from(chats).where(eq(chats.id, chat.id))
      ).toEqual([chat]);
      expect(
        await db
          .select()
          .from(chatParticipants)
          .where(eq(chatParticipants.id, participant.id))
      ).toEqual([participant]);
      expect(
        await db.select().from(messages).where(eq(messages.id, message.id))
      ).toEqual([message]);
      expect(
        await db.select().from(userBlocks).where(eq(userBlocks.id, block.id))
      ).toEqual([block]);
      expect(
        await db.select().from(userMutes).where(eq(userMutes.id, mute.id))
      ).toEqual([mute]);
    } finally {
      await cleanup(controls);
      await cleanup(owned);
    }
    // After only the independently acquired controls are removed, retrying
    // main cleanup removes every originally acquired main User.
    expect(
      await db.select().from(users).where(inArray(users.id, originalUserIds))
    ).toEqual([]);
  });
});

describe('chat fixture ownership', () => {
  it('cleans partial setup and preserves every colliding control tuple', async () => {
    const existing = ownership();
    const partial = ownership();
    const now = new Date();
    const fixtureUser = (id: string, label: string) => ({
      id,
      username: 'gchat-' + id,
      displayName: label,
      createdAt: now,
      updatedAt: now,
    });
    const acquire = async (receipt: Ownership, label: string) => {
      const userId = await generateSnowflakeId();
      const peerId = await generateSnowflakeId();
      const [user, peer] = await insertUsers(
        [fixtureUser(userId, label), fixtureUser(peerId, label + ' peer')],
        receipt
      );
      const chatId = await generateSnowflakeId();
      const [chat] = await insertChats(
        [
          {
            id: chatId,
            name: label,
            createdBy: userId,
            isGroup: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        receipt
      );
      const [participant] = await insertParticipants(
        [
          {
            id: await generateSnowflakeId(),
            chatId,
            userId,
            joinedAt: now,
            isActive: true,
          },
        ],
        receipt
      );
      const [message] = await insertMessages(
        [
          {
            id: await generateSnowflakeId(),
            chatId,
            senderId: userId,
            content: label,
            type: 'user',
            createdAt: now,
          },
        ],
        receipt
      );
      const [block] = await insertBlocks(
        [
          {
            id: await generateSnowflakeId(),
            blockerId: userId,
            blockedId: peerId,
            createdAt: now,
          },
        ],
        receipt
      );
      const [mute] = await insertMutes(
        [
          {
            id: await generateSnowflakeId(),
            muterId: userId,
            mutedId: peerId,
            createdAt: now,
          },
        ],
        receipt
      );
      if (
        !user ||
        !peer ||
        !chat ||
        !participant ||
        !message ||
        !block ||
        !mute
      ) {
        throw new Error('Missing acquired collision fixture');
      }
      return { user, peer, chat, participant, message, block, mute };
    };
    try {
      const sentinel = await acquire(existing, 'chat existing control');
      const acquired = await acquire(partial, 'chat partial setup');
      // Real failed acquisitions through each helper. The proposed ID is the
      // conflict; alternate composite-unique fields do not mask that scenario.
      await expect(
        insertUsers(
          [
            {
              ...sentinel.user,
              username: 'gchat-' + (await generateSnowflakeId()),
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertChats(
          [
            {
              ...sentinel.chat,
              name: 'rejected chat',
              createdBy: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertParticipants(
          [
            {
              ...sentinel.participant,
              chatId: acquired.chat.id,
              userId: acquired.peer.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertMessages(
          [
            {
              ...sentinel.message,
              chatId: acquired.chat.id,
              senderId: acquired.user.id,
              content: 'rejected message',
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertBlocks(
          [
            {
              ...sentinel.block,
              blockerId: acquired.peer.id,
              blockedId: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertMutes(
          [
            {
              ...sentinel.mute,
              muterId: acquired.peer.id,
              mutedId: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });

      await cleanup(partial);
      expect(
        await db
          .select()
          .from(users)
          .where(inArray(users.id, [acquired.user.id, acquired.peer.id]))
      ).toEqual([]);
      expect(
        await db.select().from(chats).where(eq(chats.id, acquired.chat.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(chatParticipants)
          .where(eq(chatParticipants.id, acquired.participant.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, acquired.message.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(userBlocks)
          .where(eq(userBlocks.id, acquired.block.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(userMutes)
          .where(eq(userMutes.id, acquired.mute.id))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, sentinel.user.id))
      ).toEqual([sentinel.user]);
      expect(
        await db.select().from(users).where(eq(users.id, sentinel.peer.id))
      ).toEqual([sentinel.peer]);
      expect(
        await db.select().from(chats).where(eq(chats.id, sentinel.chat.id))
      ).toEqual([sentinel.chat]);
      expect(
        await db
          .select()
          .from(chatParticipants)
          .where(eq(chatParticipants.id, sentinel.participant.id))
      ).toEqual([sentinel.participant]);
      expect(
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, sentinel.message.id))
      ).toEqual([sentinel.message]);
      expect(
        await db
          .select()
          .from(userBlocks)
          .where(eq(userBlocks.id, sentinel.block.id))
      ).toEqual([sentinel.block]);
      expect(
        await db
          .select()
          .from(userMutes)
          .where(eq(userMutes.id, sentinel.mute.id))
      ).toEqual([sentinel.mute]);
    } finally {
      assertCleanupSucceeded(
        await Promise.allSettled([cleanup(partial), cleanup(existing)])
      );
    }
  });
});

describe('User cleanup preserves non-owned FK references', () => {
  it('refuses all five destructive User FK paths and leaves each complete control tuple unchanged', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    const subjectRows: Array<typeof users.$inferSelect> = [];
    const now = new Date();
    try {
      // Each User belongs to a different cleanup receipt. The referencing
      // controls belong to another receipt, so none authorizes their deletion.
      for (const subject of subjects) {
        const id = await generateSnowflakeId();
        const [row] = await insertUsers(
          [
            {
              id,
              username: `gfk-${id}`,
              displayName: 'User FK refusal control',
              createdAt: now,
              updatedAt: now,
            },
          ],
          subject
        );
        if (!row) throw new Error('Missing User refusal control');
        subjectRows.push(row);
      }
      await insertOnboarding(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[0]!.id,
            createdAt: now,
            updatedAt: now,
          },
        ],
        foreign
      );
      await insertPnL(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[1]!.id,
            snapshotAt: now,
            createdAt: now,
          },
        ],
        foreign
      );
      await insertWhitelist(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[2]!.id,
            grantedBy: subjectRows[3]!.id,
            source: 'admin_manual',
            reason: 'User FK refusal control',
            grantedAt: now,
          },
        ],
        foreign
      );
      // A generated isolated row exercises the real FK without changing the
      // application singleton (id='default') or inventing a product setting.
      await insertConfigs(
        [
          {
            id: await generateSnowflakeId(),
            updatedBy: subjectRows[4]!.id,
            updatedAt: now,
          },
        ],
        foreign
      );

      for (const [index, subject] of subjects.entries()) {
        await expect(cleanup(subject)).rejects.toThrow(
          'Owned chat fixture cleanup incomplete'
        );
        const user = subjectRows[index]!;
        expect(subject.users.size).toBe(1);
        expect(
          await db.select().from(users).where(eq(users.id, user.id))
        ).toEqual([user]);
        for (const row of foreign.onboarding.values()) {
          expect(
            await db
              .select()
              .from(gameOnboarding)
              .where(eq(gameOnboarding.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.pnl.values()) {
          expect(
            await db
              .select()
              .from(userPnLSnapshots)
              .where(eq(userPnLSnapshots.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.whitelist.values()) {
          expect(
            await db.select().from(whitelist).where(eq(whitelist.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.configs.values()) {
          expect(
            await db
              .select()
              .from(whitelistConfig)
              .where(eq(whitelistConfig.id, row.id))
          ).toEqual([row]);
        }
      }
    } finally {
      // Only their independent successful RETURNING receipts authorize these
      // exact child deletes. Refusal never broadens cleanup or nulls a field.
      await cleanup(foreign);
      for (const subject of subjects) await cleanup(subject);
    }
  });
});
