/**
 * GET /api/chats against a real database: group last-message previews omit
 * authors the viewer blocked or muted and authors who blocked the viewer.
 * The preview is the newest visible message, or null when all are hidden.
 * DM previews are asserted unchanged; history-route parity is separate scope.
 *
 * Only successful INSERT RETURNING rows establish fixture ownership. Cleanup
 * preserves changed or externally referenced tuples after partial setup.
 * Requests use the existing CI-only synthetic Steward bearer; only the
 * server-only marker is stubbed, and the route/database run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  gameOnboarding,
  groupMembers,
  groups,
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
import { NextRequest } from 'next/server';

let viewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockedByAuthorId: string;
let normalAuthorId: string;

let groupAId: string;
let groupBId: string;
let groupCId: string;
let chatAId: string;
let chatBId: string;
let chatCId: string;
let dmChatId: string;

let visibleMsgId: string;
let dmMsgId: string;
let controlMsgId: string;

// Proposed IDs select setup rows; only RETURNING receipts own them.
const fixtureUserIds: string[] = [];

function ownership() {
  return {
    onboarding: new Map<string, typeof gameOnboarding.$inferSelect>(),
    pnl: new Map<string, typeof userPnLSnapshots.$inferSelect>(),
    whitelist: new Map<string, typeof whitelist.$inferSelect>(),
    configs: new Map<string, typeof whitelistConfig.$inferSelect>(),
    users: new Map<string, typeof users.$inferSelect>(),
    chats: new Map<string, typeof chats.$inferSelect>(),
    groups: new Map<string, typeof groups.$inferSelect>(),
    members: new Map<string, typeof groupMembers.$inferSelect>(),
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

async function insertGroups(
  values: Array<typeof groups.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(groups).values(values).returning();
  for (const row of rows) receipt.groups.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete groups RETURNING');
  return rows;
}

async function insertMembers(
  values: Array<typeof groupMembers.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(groupMembers).values(values).returning();
  for (const row of rows) receipt.members.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete groupMembers RETURNING');
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
      receipt.members,
      async (row) => {
        await db
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.id, row.id),
              sql`to_jsonb(${groupMembers}) = to_jsonb(jsonb_populate_record(NULL::"GroupMember", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: groupMembers.id })
          .from(groupMembers)
          .where(eq(groupMembers.id, id))
    )),
    ...(await removeRows(
      receipt.chats,
      async (row) => {
        await db
          .delete(chats)
          .where(
            and(
              eq(chats.id, row.id),
              sql`to_jsonb(${chats}) = to_jsonb(jsonb_populate_record(NULL::"Chat", ${JSON.stringify(row)}::jsonb))`,
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
      receipt.groups,
      async (row) => {
        await db
          .delete(groups)
          .where(
            and(
              eq(groups.id, row.id),
              sql`to_jsonb(${groups}) = to_jsonb(jsonb_populate_record(NULL::"Group", ${JSON.stringify(row)}::jsonb))`,
              sql`NOT EXISTS (SELECT 1 FROM ${groupMembers} WHERE ${groupMembers.groupId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${chats} WHERE ${chats.groupId} = ${row.id})`
            )
          );
      },
      async (id) =>
        db.select({ id: groups.id }).from(groups).where(eq(groups.id, id))
    )),
    ...(await removeRows(
      receipt.users,
      async (row) => {
        await db.delete(users).where(
          and(
            eq(users.id, row.id),
            sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${JSON.stringify(row)}::jsonb))`,
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
            sql`NOT EXISTS (SELECT 1 FROM ${groups} WHERE ${groups.ownerId} = ${row.id} OR ${groups.createdById} = ${row.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${groupMembers} WHERE ${groupMembers.userId} = ${row.id})`,
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

let GET: typeof import('../../../apps/web/src/app/api/chats/route').GET;

// The synthetic test bearer prefix, assembled at runtime.
const testBearer = (userId: string) =>
  `Bearer ${['stew', 'ard'].join('')}:test:${userId}`;

type ChatListPayload = {
  groupChats: Array<{
    id: string;
    lastMessage: { id: string; senderId: string; content: string } | null;
  }>;
  directChats: Array<{
    id: string;
    lastMessage: { id: string; senderId: string; content: string } | null;
  }>;
  total: number;
};

async function listChats() {
  const request = new NextRequest(
    new Request('http://localhost/api/chats', {
      method: 'GET',
      headers: { authorization: testBearer(viewerId) },
    })
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | ({ data?: ChatListPayload } & ChatListPayload)
    | null;
  return body?.data ?? body;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/route'));

  const ids = await Promise.all(
    Array.from({ length: 12 }, () => generateSnowflakeId())
  );
  [
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId,
    groupAId,
    groupBId,
    groupCId,
    chatAId,
    chatBId,
    chatCId,
    dmChatId,
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
  ];
  fixtureUserIds.push(
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId
  );

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-g43-${label}-${id}`,
    displayName: `G43 ${label}`,
    createdAt: now,
    updatedAt: now,
  });
  await insertUsers([
    seedUser(viewerId, 'viewer'),
    seedUser(blockedAuthorId, 'blocked'),
    seedUser(mutedAuthorId, 'muted'),
    seedUser(blockedByAuthorId, 'blockedby'),
    seedUser(normalAuthorId, 'normal'),
  ]);

  const seedGroup = (id: string, name: string): typeof groups.$inferInsert => ({
    id,
    name,
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });
  await insertGroups([
    seedGroup(groupAId, 'G43 Group A'),
    seedGroup(groupBId, 'G43 Group B'),
    seedGroup(groupCId, 'G43 Group C'),
  ]);

  await insertChats([
    {
      id: chatAId,
      name: 'G43 Group A',
      isGroup: true,
      groupId: groupAId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: chatBId,
      name: 'G43 Group B',
      isGroup: true,
      groupId: groupBId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: chatCId,
      name: 'G43 Group C',
      isGroup: true,
      groupId: groupCId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: dmChatId,
      name: null,
      isGroup: false,
      groupId: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Every author is an active member of every group; the viewer is a
  // member of all three groups and a participant in the DM.
  const memberRows = [groupAId, groupBId, groupCId].flatMap((groupId) =>
    fixtureUserIds.map((userId) => ({ groupId, userId }))
  );
  const memberIds = await Promise.all(
    memberRows.map(() => generateSnowflakeId())
  );
  await insertMembers(
    memberRows.map((row, i) => ({
      id: memberIds[i]!,
      ...row,
      role: row.userId === viewerId ? 'owner' : 'member',
      isActive: true,
      joinedAt: now,
    }))
  );

  const participantRows = [
    { chatId: dmChatId, userId: viewerId },
    { chatId: dmChatId, userId: blockedAuthorId },
  ];
  const participantIds = await Promise.all(
    participantRows.map(() => generateSnowflakeId())
  );
  await insertParticipants(
    participantRows.map((row, i) => ({
      id: participantIds[i]!,
      ...row,
      isActive: true,
      joinedAt: now,
    }))
  );

  // The viewer's moderation relationships, plus the reverse block.
  const relIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await insertBlocks([
    {
      id: relIds[0]!,
      blockerId: viewerId,
      blockedId: blockedAuthorId,
      createdAt: now,
    },
    {
      id: relIds[1]!,
      blockerId: blockedByAuthorId,
      blockedId: viewerId,
      createdAt: now,
    },
  ]);
  await insertMutes([
    {
      id: relIds[2]!,
      muterId: viewerId,
      mutedId: mutedAuthorId,
      createdAt: now,
    },
  ]);

  // Messages, fixed timestamps one minute apart per group.
  const base = Date.UTC(2026, 10, 8, 12, 0, 0);
  const at = (minute: number) => new Date(base + minute * 60_000);
  const msgIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  const [
    visibleMsg,
    blockedLatest,
    mutedOnly,
    blockedByOnly,
    controlMsg,
    dmMsg,
  ] = msgIds as [string, string, string, string, string, string];
  visibleMsgId = visibleMsg;
  controlMsgId = controlMsg;
  dmMsgId = dmMsg;

  await insertMessages([
    // Group A: a visible message, then the blocked author's newer one.
    {
      id: visibleMsg,
      chatId: chatAId,
      senderId: normalAuthorId,
      content: 'g43 visible group message',
      type: 'user',
      createdAt: at(1),
    },
    {
      id: blockedLatest,
      chatId: chatAId,
      senderId: blockedAuthorId,
      content: 'g43 blocked author latest',
      type: 'user',
      createdAt: at(2),
    },
    // Group B: only hidden authors ever wrote here.
    {
      id: mutedOnly,
      chatId: chatBId,
      senderId: mutedAuthorId,
      content: 'g43 muted author message',
      type: 'user',
      createdAt: at(1),
    },
    {
      id: blockedByOnly,
      chatId: chatBId,
      senderId: blockedByAuthorId,
      content: 'g43 blocked-by author message',
      type: 'user',
      createdAt: at(2),
    },
    // Group C (control): the newest message is from a visible author.
    {
      id: controlMsg,
      chatId: chatCId,
      senderId: normalAuthorId,
      content: 'g43 normal latest message',
      type: 'user',
      createdAt: at(1),
    },
    // DM with the blocked author: out of scope, asserted unchanged.
    {
      id: dmMsg,
      chatId: dmChatId,
      senderId: blockedAuthorId,
      content: 'g43 dm message from blocked author',
      type: 'user',
      createdAt: at(1),
    },
  ]);
});

afterAll(async () => {
  await cleanup(owned);
});

describe('GET /api/chats group last-message preview and viewer moderation', () => {
  it('previews the newest visible message when the newest is from a blocked author', async () => {
    const data = await listChats();
    const groupA = data?.groupChats.find((c) => c.id === chatAId);
    expect(groupA).toBeDefined();
    expect(groupA!.lastMessage?.id).toBe(visibleMsgId);
    expect(groupA!.lastMessage?.content).toBe('g43 visible group message');
  });

  it('shows no preview when every message in the group is from a hidden author', async () => {
    const data = await listChats();
    const groupB = data?.groupChats.find((c) => c.id === chatBId);
    expect(groupB).toBeDefined();
    expect(groupB!.lastMessage).toBeNull();
  });

  it('keeps the newest message as preview when its author is visible', async () => {
    const data = await listChats();
    const groupC = data?.groupChats.find((c) => c.id === chatCId);
    expect(groupC).toBeDefined();
    expect(groupC!.lastMessage?.id).toBe(controlMsgId);
  });

  it('leaves DM previews unchanged', async () => {
    const data = await listChats();
    const dm = data?.directChats.find((c) => c.id === dmChatId);
    expect(dm).toBeDefined();
    expect(dm!.lastMessage?.id).toBe(dmMsgId);
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
      const groupId = await generateSnowflakeId();
      const [group] = await insertGroups(
        [
          {
            id: groupId,
            name: label,
            type: 'user',
            ownerId: userId,
            createdById: userId,
            createdAt: now,
            updatedAt: now,
          },
        ],
        receipt
      );
      const [member] = await insertMembers(
        [
          {
            id: await generateSnowflakeId(),
            groupId,
            userId,
            role: 'owner',
            isActive: true,
            joinedAt: now,
          },
        ],
        receipt
      );
      const chatId = await generateSnowflakeId();
      const [chat] = await insertChats(
        [
          {
            id: chatId,
            name: label,
            groupId,
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
        !group ||
        !member ||
        !participant ||
        !message ||
        !block ||
        !mute
      ) {
        throw new Error('Missing acquired collision fixture');
      }
      return {
        user,
        peer,
        group,
        member,
        chat,
        participant,
        message,
        block,
        mute,
      };
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
        insertGroups(
          [
            {
              ...sentinel.group,
              name: 'rejected group',
              ownerId: acquired.user.id,
              createdById: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertMembers(
          [
            {
              ...sentinel.member,
              groupId: acquired.group.id,
              userId: acquired.peer.id,
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
        await db.select().from(groups).where(eq(groups.id, acquired.group.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(groupMembers)
          .where(eq(groupMembers.id, acquired.member.id))
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
        await db.select().from(groups).where(eq(groups.id, sentinel.group.id))
      ).toEqual([sentinel.group]);
      expect(
        await db
          .select()
          .from(groupMembers)
          .where(eq(groupMembers.id, sentinel.member.id))
      ).toEqual([sentinel.member]);
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
