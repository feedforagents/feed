/** PRD §9.5/§12, MVP phase 5: existing group membership visibility. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { and, chatParticipants, chats, db, eq, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const responseSchema = z.object({
  participants: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable(),
      username: z.string().nullable(),
      profileImageUrl: z.string().nullable(),
    })
  ),
});
const owned = {
  users: new Set<string>(),
  chats: new Set<string>(),
  participants: new Set<string>(),
};
let viewer = '',
  active = '',
  inactive = '',
  outsider = '',
  chatId = '',
  soloChatId = '',
  inactiveChatId = '',
  missingChatId = '',
  activeMembership = '';
const tokens = new Map<string, string>();

async function insertChats(
  rows: Array<typeof chats.$inferInsert>,
  ownership = owned.chats
) {
  const inserted = await db
    .insert(chats)
    .values(rows)
    .returning({ id: chats.id });
  for (const row of inserted) ownership.add(row.id);
}
async function cleanChats(ownership: Set<string>) {
  if (ownership.size)
    await db.delete(chats).where(inArray(chats.id, [...ownership]));
}
function signed(id = viewer) {
  const token = tokens.get(id);
  assert.ok(token);
  return { authorization: `Bearer ${token}` };
}
async function request(
  id = chatId,
  headers: Record<string, string> = signed()
) {
  return fetch(`${baseUrl}/api/chats/${id}/participants`, {
    headers,
    cache: 'no-store',
    redirect: 'error',
  });
}
async function list(id = chatId, headers: Record<string, string> = signed()) {
  const response = await request(id, headers);
  assert.equal(response.status, 200);
  return responseSchema.parse(await response.json()).participants;
}
function ids(rows: Array<{ id: string }>) {
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  viewer = await generateSnowflakeId();
  active = await generateSnowflakeId();
  inactive = await generateSnowflakeId();
  outsider = await generateSnowflakeId();
  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values(
      [viewer, active, inactive, outsider].map((id) => ({
        id,
        username: `participant-fixture-${id}`,
        displayName: `Participant fixture ${id}`,
        stewardId: `participant-steward-${id}`,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);
  chatId = await generateSnowflakeId();
  soloChatId = await generateSnowflakeId();
  inactiveChatId = await generateSnowflakeId();
  missingChatId = await generateSnowflakeId();
  await insertChats(
    [chatId, soloChatId, inactiveChatId].map((id) => ({
      id,
      name: `Participant fixture chat ${id}`,
      isGroup: true,
      createdBy: viewer,
      updatedAt: now,
    }))
  );
  async function membership(group: string, userId: string, isActive: boolean) {
    return { id: await generateSnowflakeId(), chatId: group, userId, isActive };
  }
  const rows = [
    await membership(chatId, viewer, true),
    await membership(chatId, active, true),
    await membership(chatId, inactive, false),
    await membership(soloChatId, viewer, true),
    await membership(soloChatId, inactive, false),
    await membership(inactiveChatId, viewer, false),
    await membership(inactiveChatId, active, false),
  ];
  const insertedParticipants = await db
    .insert(chatParticipants)
    .values(rows)
    .returning({ id: chatParticipants.id });
  for (const row of insertedParticipants) owned.participants.add(row.id);
  const member = rows.find(
    (row) => row.chatId === chatId && row.userId === active
  );
  assert.ok(member);
  activeMembership = member.id;
  for (const id of [viewer, active, inactive, outsider]) {
    tokens.set(id, await createStewardTestToken(`participant-steward-${id}`));
  }
});

afterAll(async () => {
  if (owned.participants.size)
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, [...owned.participants]));
  await cleanChats(owned.chats);
  if (owned.users.size)
    await db.delete(users).where(inArray(users.id, [...owned.users]));
});

test('lists only current members and preserves the four existing user fields', async () => {
  const rows = await list();
  expect(ids(rows)).toEqual([viewer, active].sort());
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === active)).toEqual({
    id: active,
    displayName: `Participant fixture ${active}`,
    username: `participant-fixture-${active}`,
    profileImageUrl: null,
  });
  const activeRows = await db
    .select({ id: chatParticipants.userId })
    .from(chatParticipants)
    .where(
      and(
        eq(chatParticipants.chatId, chatId),
        eq(chatParticipants.isActive, true)
      )
    );
  expect(ids(rows)).toEqual(ids(activeRows));
});
test('cookie credentials resolve the same active requester', async () => {
  const token = tokens.get(viewer);
  assert.ok(token);
  expect(ids(await list(chatId, { cookie: `steward-token=${token}` }))).toEqual(
    [viewer, active].sort()
  );
});
test('inactive and unrelated requesters cannot inspect participants', async () => {
  for (const id of [inactive, outsider]) {
    const response = await request(chatId, signed(id));
    expect(response.status).toBe(400); // Existing BusinessLogicError contract, not a new status policy.
    const body = z.object({ error: z.string() }).parse(await response.json());
    expect(body.error).toContain('participant');
  }
  const response = await request(inactiveChatId);
  expect(response.status).toBe(400);
  await response.arrayBuffer();
});
test('only the active viewer remains when every other membership is inactive', async () => {
  expect(ids(await list(soloChatId))).toEqual([viewer]);
});
test('same-URL reads reflect an owned member deactivation and restoration', async () => {
  await db
    .update(chatParticipants)
    .set({ isActive: false })
    .where(eq(chatParticipants.id, activeMembership));
  try {
    expect(ids(await list())).toEqual([viewer]);
    const denied = await request(chatId, signed(active));
    expect(denied.status).toBe(400);
    await denied.arrayBuffer();
  } finally {
    await db
      .update(chatParticipants)
      .set({ isActive: true })
      .where(eq(chatParticipants.id, activeMembership));
  }
  expect(ids(await list())).toEqual([viewer, active].sort());
});
test('requires authentication and preserves the missing-chat guard', async () => {
  const headerCases: Array<Record<string, string>> = [
    {},
    { authorization: 'Bearer invalid-token' },
  ];
  for (const headers of headerCases) {
    const response = await request(chatId, headers);
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  const missing = await request(missingChatId);
  expect(missing.status).toBe(404);
  await missing.arrayBuffer();
});
test('failed setup cannot delete or overwrite an already existing chat', async () => {
  const failedOwnership = new Set<string>();
  await expect(
    insertChats(
      [{ id: chatId, name: 'must-not-replace', updatedAt: new Date() }],
      failedOwnership
    )
  ).rejects.toThrow();
  expect(failedOwnership.size).toBe(0);
  await cleanChats(failedOwnership);
  const [existing] = await db
    .select({ name: chats.name })
    .from(chats)
    .where(eq(chats.id, chatId));
  expect(existing?.name).toBe(`Participant fixture chat ${chatId}`);
});
