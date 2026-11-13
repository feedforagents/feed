/** F134 probe: web chat list (GET /api/chats) composition & reachability. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  and,
  chatParticipants,
  chats,
  count,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  pointsTransactions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

const owned = {
  users: new Set<string>(),
  chats: new Set<string>(),
  groups: new Set<string>(),
};
const tokens = new Map<string, string>();
let viewer = '';
let member1 = '';
let member2 = '';
let leaver = '';
let outsider = '';
let directGroupChatId = '';
let leftGroupChatId = '';
let emptyGroupChatId = '';
let backedGroupChatId = '';
const dmChatIds: string[] = [];
const tiedGroupChatIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `f134-${label}-${id}`,
    displayName: `F134 ${label} ${id}`,
    stewardId: `f134-steward-${id}`,
    updatedAt: new Date(),
  });
  owned.users.add(id);
  tokens.set(id, await createStewardTestToken(`f134-steward-${id}`));
  return id;
}

function signed(id: string) {
  const token = tokens.get(id);
  assert.ok(token);
  return { authorization: `Bearer ${token}` };
}

type ChatListEntry = {
  id: string;
  name: string;
  isGroup: boolean;
  lastMessage: {
    id: string;
    content: string;
    senderId: string;
  } | null;
  messageCount?: number;
  participants?: number;
};

async function getList(id: string) {
  const res = await fetch(`${baseUrl}/api/chats`, { headers: signed(id) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    groupChats: ChatListEntry[];
    directChats: ChatListEntry[];
    total: number;
  };
  assert.equal(body.total, body.groupChats.length + body.directChats.length);
  return body;
}

async function postDirectGroup(
  name: string,
  participantIds: string[]
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: { ...signed(viewer), 'content-type': 'application/json' },
    body: JSON.stringify({ name, isGroup: true, participantIds }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { chat: { id: string } };
  owned.chats.add(body.chat.id);
  return body.chat.id;
}

/**
 * Delete the reputation ledger rows derived from fixture activity.
 * awardReputationInTx writes a PointsTransaction for the chat creator with
 * no cascading FK to User, so teardown must remove these rows explicitly,
 * before the owned users themselves are deleted. Keyed strictly by the
 * user IDs this fixture successfully created.
 */
async function deleteOwnedLedgerRows(userIds: string[]) {
  if (!userIds.length) return;
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, userIds));
}

beforeAll(async () => {
  viewer = await makeUser('viewer');
  member1 = await makeUser('member1');
  member2 = await makeUser('member2');
  leaver = await makeUser('leaver');
  outsider = await makeUser('outsider');

  // A: direct group chat created through the public POST /api/chats endpoint
  // (chatParticipants-based, no Group row, chats.groupId stays null).
  directGroupChatId = await postDirectGroup('F134 direct group', [
    member1,
    member2,
  ]);
  await db.insert(messages).values({
    id: await generateSnowflakeId(),
    chatId: directGroupChatId,
    senderId: member1,
    content: 'hello from a direct group chat',
    createdAt: new Date('2026-03-01T00:00:00Z'),
  });

  // A-left: a second direct group chat whose invited participant has left
  // (the leave flow retains the participant row with isActive = false).
  leftGroupChatId = await postDirectGroup('F134 left group', [leaver, member2]);
  await db
    .update(chatParticipants)
    .set({ isActive: false })
    .where(
      and(
        eq(chatParticipants.chatId, leftGroupChatId),
        eq(chatParticipants.userId, leaver)
      )
    );

  // A-empty: a direct group chat with no messages yet.
  emptyGroupChatId = await postDirectGroup('F134 empty group', [member1]);

  // B: group-backed chat (Group + GroupMember + chats.groupId), the shape
  // produced by /api/groups, A2A create_group and MCP create_group.
  const groupId = await generateSnowflakeId();
  backedGroupChatId = await generateSnowflakeId();
  const now = new Date('2026-03-02T00:00:00Z');
  await db.insert(groups).values({
    id: groupId,
    name: 'F134 backed group',
    type: 'user',
    ownerId: viewer,
    createdById: viewer,
    createdAt: now,
    updatedAt: now,
  });
  owned.groups.add(groupId);
  await db.insert(chats).values({
    id: backedGroupChatId,
    name: 'F134 backed group',
    isGroup: true,
    groupId,
    createdAt: now,
    updatedAt: now,
  });
  owned.chats.add(backedGroupChatId);
  await db.insert(groupMembers).values([
    {
      id: await generateSnowflakeId(),
      groupId,
      userId: viewer,
      role: 'owner',
      isActive: true,
      lastMessageAt: now,
    },
    {
      id: await generateSnowflakeId(),
      groupId,
      userId: member1,
      role: 'member',
      isActive: true,
      lastMessageAt: now,
    },
  ]);

  // C: 30 DM chats; 15 share one identical last-message timestamp (ties).
  const tieTime = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    const other = await makeUser(`dm${i}`);
    const chatId = await generateSnowflakeId();
    const created = new Date('2025-12-01T00:00:00Z');
    await db.insert(chats).values({
      id: chatId,
      name: null,
      isGroup: false,
      createdAt: created,
      updatedAt: created,
    });
    owned.chats.add(chatId);
    dmChatIds.push(chatId);
    await db.insert(chatParticipants).values([
      { id: await generateSnowflakeId(), chatId, userId: viewer },
      { id: await generateSnowflakeId(), chatId, userId: other },
    ]);
    await db.insert(messages).values({
      id: await generateSnowflakeId(),
      chatId,
      senderId: other,
      content: `dm ${i}`,
      createdAt: i < 15 ? tieTime : new Date(Date.UTC(2026, 0, 2, 0, i, 0)),
    });
  }

  // D: 25 group-backed chats whose memberships share one lastMessageAt.
  const tiedAt = new Date('2026-02-02T00:00:00Z');
  for (let i = 0; i < 25; i++) {
    const gid = await generateSnowflakeId();
    const cid = await generateSnowflakeId();
    await db.insert(groups).values({
      id: gid,
      name: `F134 tied group ${i}`,
      type: 'user',
      ownerId: viewer,
      createdById: viewer,
      createdAt: tiedAt,
      updatedAt: tiedAt,
    });
    owned.groups.add(gid);
    await db.insert(chats).values({
      id: cid,
      name: `F134 tied group ${i}`,
      isGroup: true,
      groupId: gid,
      createdAt: tiedAt,
      updatedAt: tiedAt,
    });
    owned.chats.add(cid);
    tiedGroupChatIds.push(cid);
    await db.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId: gid,
      userId: viewer,
      role: 'owner',
      isActive: true,
      lastMessageAt: tiedAt,
    });
  }
});

afterAll(async () => {
  // Derived reputation ledger rows first: they reference the owned users
  // and survive user deletion because there is no cascading FK.
  await deleteOwnedLedgerRows([...owned.users]);
  if (owned.chats.size) {
    const ids = [...owned.chats];
    await db.delete(messages).where(inArray(messages.chatId, ids));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, ids));
    await db.delete(chats).where(inArray(chats.id, ids));
  }
  if (owned.groups.size) {
    const ids = [...owned.groups];
    await db.delete(groupMembers).where(inArray(groupMembers.groupId, ids));
    await db.delete(groups).where(inArray(groups.id, ids));
  }
  if (owned.users.size)
    await db.delete(users).where(inArray(users.id, [...owned.users]));

  // Cleanup evidence: nothing this fixture owned may remain behind.
  if (owned.users.size) {
    const ids = [...owned.users];
    const [ledgerLeft] = await db
      .select({ value: count() })
      .from(pointsTransactions)
      .where(inArray(pointsTransactions.userId, ids));
    assert.equal(ledgerLeft?.value ?? 0, 0);
    const [usersLeft] = await db
      .select({ value: count() })
      .from(users)
      .where(inArray(users.id, ids));
    assert.equal(usersLeft?.value ?? 0, 0);
  }
});

test('A1: a group chat created via POST /api/chats appears in the creator chat list', async () => {
  const list = await getList(viewer);
  expect(list.groupChats.map((c) => c.id)).toContain(directGroupChatId);
});

test('A2: the same direct group chat appears in an invited participant chat list', async () => {
  const list = await getList(member1);
  expect(list.groupChats.map((c) => c.id)).toContain(directGroupChatId);
});

test('A3: the direct group entry carries the preview and message count of its only message', async () => {
  const list = await getList(viewer);
  const entry = list.groupChats.find((c) => c.id === directGroupChatId);
  assert.ok(entry);
  expect(entry.isGroup).toBe(true);
  expect(entry.name).toBe('F134 direct group');
  expect(entry.messageCount).toBe(1);
  expect(entry.lastMessage?.content).toBe('hello from a direct group chat');
  expect(entry.lastMessage?.senderId).toBe(member1);
});

test('A4: an empty direct group chat is listed with a null preview and a zero count', async () => {
  const list = await getList(viewer);
  const entry = list.groupChats.find((c) => c.id === emptyGroupChatId);
  assert.ok(entry);
  expect(entry.isGroup).toBe(true);
  expect(entry.lastMessage).toBeNull();
  expect(entry.messageCount).toBe(0);
});

test('B1: a group-backed chat appears in the chat list (control)', async () => {
  const list = await getList(viewer);
  expect(list.groupChats.map((c) => c.id)).toContain(backedGroupChatId);
});

test('C1: all 30 DM chats are listed exactly once despite tied last-message times', async () => {
  const list = await getList(viewer);
  const listed = list.directChats
    .map((c) => c.id)
    .filter((id) => dmChatIds.includes(id));
  expect(listed.sort()).toEqual([...dmChatIds].sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test('D1: all 25 group chats with tied membership lastMessageAt are listed exactly once', async () => {
  const list = await getList(viewer);
  const listed = list.groupChats
    .map((c) => c.id)
    .filter((id) => tiedGroupChatIds.includes(id));
  expect(listed.sort()).toEqual([...tiedGroupChatIds].sort());
  expect(new Set(listed).size).toBe(listed.length);
});

test('N1: a participant who left a direct group chat no longer sees it, active members still do', async () => {
  const leaverList = await getList(leaver);
  expect(leaverList.groupChats.map((c) => c.id)).not.toContain(leftGroupChatId);
  const viewerList = await getList(viewer);
  expect(viewerList.groupChats.map((c) => c.id)).toContain(leftGroupChatId);
});

test('N2: an unrelated user sees none of the fixture group chats', async () => {
  const list = await getList(outsider);
  const ids = list.groupChats.map((c) => c.id);
  expect(ids).not.toContain(directGroupChatId);
  expect(ids).not.toContain(leftGroupChatId);
  expect(ids).not.toContain(emptyGroupChatId);
  expect(ids).not.toContain(backedGroupChatId);
});

test('N3: missing or invalid credentials are rejected', async () => {
  const missing = await fetch(`${baseUrl}/api/chats`);
  expect(missing.status).toBe(401);
  const invalid = await fetch(`${baseUrl}/api/chats`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  expect(invalid.status).toBe(401);
});

test('E1: creating a direct group chat writes a reputation ledger row for the creator', async () => {
  const rows = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.userId, viewer),
        eq(pointsTransactions.reason, 'private_channel_create')
      )
    );
  expect(rows.length).toBeGreaterThanOrEqual(1);
});

test('F1: ledger cleanup removes owned rows and preserves foreign rows', async () => {
  // A foreign user this fixture did not create (collision control): its
  // ledger row must survive a cleanup scoped to fixture-owned users.
  const foreignId = await generateSnowflakeId();
  await db.insert(users).values({
    id: foreignId,
    username: `f134-foreign-${foreignId}`,
    displayName: `F134 foreign ${foreignId}`,
    stewardId: `f134-steward-foreign-${foreignId}`,
    updatedAt: new Date(),
  });
  await db.insert(pointsTransactions).values({
    id: await generateSnowflakeId(),
    userId: foreignId,
    amount: 1,
    pointsBefore: 0,
    pointsAfter: 1,
    reason: 'private_channel_create',
  });
  const tempId = await makeUser('temp');
  await db.insert(pointsTransactions).values({
    id: await generateSnowflakeId(),
    userId: tempId,
    amount: 1,
    pointsBefore: 0,
    pointsAfter: 1,
    reason: 'private_channel_create',
  });

  await deleteOwnedLedgerRows([tempId]);

  const tempLeft = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, tempId));
  expect(tempLeft.length).toBe(0);
  const foreignLeft = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, foreignId));
  expect(foreignLeft.length).toBe(1);

  // The foreign rows were created by this file, so the file owns their
  // final removal once the control assertions are done.
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, foreignId));
  await db.delete(users).where(eq(users.id, foreignId));
});
