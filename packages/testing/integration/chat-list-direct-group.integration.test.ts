/** F134 probe: web chat list (GET /api/chats) composition & reachability. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chatParticipants,
  chats,
  db,
  groupMembers,
  groups,
  inArray,
  messages,
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
let directGroupChatId = '';
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

async function getList(id: string) {
  const res = await fetch(`${baseUrl}/api/chats`, { headers: signed(id) });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    groupChats: Array<{ id: string }>;
    directChats: Array<{ id: string }>;
    total: number;
  };
}

beforeAll(async () => {
  viewer = await makeUser('viewer');
  member1 = await makeUser('member1');
  member2 = await makeUser('member2');

  // A: direct group chat created through the public POST /api/chats endpoint
  // (chatParticipants-based, no Group row, chats.groupId stays null).
  const postRes = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: { ...signed(viewer), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'F134 direct group',
      isGroup: true,
      participantIds: [member1, member2],
    }),
  });
  assert.equal(postRes.status, 201);
  const postBody = (await postRes.json()) as { chat: { id: string } };
  directGroupChatId = postBody.chat.id;
  owned.chats.add(directGroupChatId);
  await db.insert(messages).values({
    id: await generateSnowflakeId(),
    chatId: directGroupChatId,
    senderId: member1,
    content: 'hello from a direct group chat',
    createdAt: new Date('2026-03-01T00:00:00Z'),
  });

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
});

test('A1: a group chat created via POST /api/chats appears in the creator chat list', async () => {
  const list = await getList(viewer);
  expect(list.groupChats.map((c) => c.id)).toContain(directGroupChatId);
});

test('A2: the same direct group chat appears in an invited participant chat list', async () => {
  const list = await getList(member1);
  expect(list.groupChats.map((c) => c.id)).toContain(directGroupChatId);
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
