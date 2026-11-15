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
  gameOnboarding,
  groupMembers,
  groups,
  inArray,
  messages,
  notInArray,
  pointsTransactions,
  userBlocks,
  userPnLSnapshots,
  users,
  whitelist,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

// Strict guards: writes go only to a disposable local database and
// requests only to an owned loopback server.
function assertDisposableDatabaseUrl(
  value: string | undefined,
  label: string
): string {
  if (!value) throw new Error(`${label} is required for integration tests`);
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !/(?:^|[_-])(test|testing|verification)(?:[_-]|$)/i.test(databaseName)
  ) {
    throw new Error(
      `${label} must point to a local test or verification database`
    );
  }
  return databaseName;
}
assertDisposableDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
const target = new URL(baseUrl);
if (
  target.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
)
  throw new Error('Owned loopback server required');

const owned = {
  users: new Set<string>(),
  chats: new Set<string>(),
  groups: new Set<string>(),
  // Every child row is registered only from its own successful write, by
  // exact row id. Cleanup deletes exactly these ids and refuses when an
  // unrecorded row sits under an owned parent, so a setup that fails
  // partway — or a foreign row added later — can never be deleted by
  // this fixture.
  messages: new Set<string>(),
  participants: new Set<string>(),
  groupMembers: new Set<string>(),
  ledger: new Set<string>(),
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
  // The POST's verified ledger effect: snapshot the creator's
  // private_channel_create rows first, then record only the rows the
  // call itself added.
  const ledgerBefore = new Set(
    (
      await db
        .select({ id: pointsTransactions.id })
        .from(pointsTransactions)
        .where(
          and(
            eq(pointsTransactions.userId, viewer),
            eq(pointsTransactions.reason, 'private_channel_create')
          )
        )
    ).map((row) => row.id)
  );
  const res = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: { ...signed(viewer), 'content-type': 'application/json' },
    body: JSON.stringify({ name, isGroup: true, participantIds }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { chat: { id: string } };
  owned.chats.add(body.chat.id);
  const ledgerAfter = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.userId, viewer),
        eq(pointsTransactions.reason, 'private_channel_create')
      )
    );
  for (const row of ledgerAfter) {
    if (!ledgerBefore.has(row.id)) owned.ledger.add(row.id);
  }
  // The endpoint creates the participant rows; record the exact ids it made.
  const createdParticipants = await db
    .select({ id: chatParticipants.id })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, body.chat.id));
  for (const row of createdParticipants) owned.participants.add(row.id);
  return body.chat.id;
}

/**
 * Delete reputation ledger rows by exact row id — never by user id. A
 * ledger row for an owned user that this fixture did not record (for
 * example a second award written by another flow) must survive.
 */
async function deleteLedgerRowsById(ids: string[]) {
  if (!ids.length) return;
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.id, ids));
}

/**
 * Guarded fixture cleanup: refuse when an unrecorded child row sits under
 * an owned parent, or when an owned user still has a row that would vanish
 * through ON DELETE CASCADE (GameOnboarding, UserPnLSnapshot, Whitelist).
 * The refusal check and the deletes run in one transaction, so the decision
 * and the deletion cannot drift apart. On success only the exact recorded
 * row ids are deleted, then the registry is cleared.
 */
async function cleanupOwnedFixtures(): Promise<void> {
  await db.transaction(async (tx) => {
    if (owned.users.size) {
      const userIds = [...owned.users];
      const [strayLedger] = await tx
        .select({ id: pointsTransactions.id })
        .from(pointsTransactions)
        .where(
          owned.ledger.size
            ? and(
                inArray(pointsTransactions.userId, userIds),
                notInArray(pointsTransactions.id, [...owned.ledger])
              )
            : inArray(pointsTransactions.userId, userIds)
        )
        .limit(1);
      if (strayLedger)
        throw new Error(
          `cleanup refused: unrecorded PointsTransaction ${strayLedger.id} for an owned user`
        );
      const [onboarding] = await tx
        .select({ id: gameOnboarding.id })
        .from(gameOnboarding)
        .where(inArray(gameOnboarding.userId, userIds))
        .limit(1);
      if (onboarding)
        throw new Error(
          `cleanup refused: GameOnboarding ${onboarding.id} references an owned user`
        );
      const [snapshot] = await tx
        .select({ id: userPnLSnapshots.id })
        .from(userPnLSnapshots)
        .where(inArray(userPnLSnapshots.userId, userIds))
        .limit(1);
      if (snapshot)
        throw new Error(
          `cleanup refused: UserPnLSnapshot ${snapshot.id} references an owned user`
        );
      const [whitelistRow] = await tx
        .select({ id: whitelist.id })
        .from(whitelist)
        .where(inArray(whitelist.userId, userIds))
        .limit(1);
      if (whitelistRow)
        throw new Error(
          `cleanup refused: Whitelist ${whitelistRow.id} references an owned user`
        );
    }
    if (owned.chats.size) {
      const chatIds = [...owned.chats];
      const [strayMessage] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          owned.messages.size
            ? and(
                inArray(messages.chatId, chatIds),
                notInArray(messages.id, [...owned.messages])
              )
            : inArray(messages.chatId, chatIds)
        )
        .limit(1);
      if (strayMessage)
        throw new Error(
          `cleanup refused: unrecorded Message ${strayMessage.id} in an owned chat`
        );
      const [strayParticipant] = await tx
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          owned.participants.size
            ? and(
                inArray(chatParticipants.chatId, chatIds),
                notInArray(chatParticipants.id, [...owned.participants])
              )
            : inArray(chatParticipants.chatId, chatIds)
        )
        .limit(1);
      if (strayParticipant)
        throw new Error(
          `cleanup refused: unrecorded ChatParticipant ${strayParticipant.id} in an owned chat`
        );
    }
    if (owned.groups.size) {
      const [strayMember] = await tx
        .select({ id: groupMembers.id })
        .from(groupMembers)
        .where(
          owned.groupMembers.size
            ? and(
                inArray(groupMembers.groupId, [...owned.groups]),
                notInArray(groupMembers.id, [...owned.groupMembers])
              )
            : inArray(groupMembers.groupId, [...owned.groups])
        )
        .limit(1);
      if (strayMember)
        throw new Error(
          `cleanup refused: unrecorded GroupMember ${strayMember.id} in an owned group`
        );
    }
    if (owned.ledger.size)
      await tx
        .delete(pointsTransactions)
        .where(inArray(pointsTransactions.id, [...owned.ledger]));
    if (owned.messages.size)
      await tx
        .delete(messages)
        .where(inArray(messages.id, [...owned.messages]));
    if (owned.participants.size)
      await tx
        .delete(chatParticipants)
        .where(inArray(chatParticipants.id, [...owned.participants]));
    if (owned.chats.size)
      await tx.delete(chats).where(inArray(chats.id, [...owned.chats]));
    if (owned.groupMembers.size)
      await tx
        .delete(groupMembers)
        .where(inArray(groupMembers.id, [...owned.groupMembers]));
    if (owned.groups.size)
      await tx.delete(groups).where(inArray(groups.id, [...owned.groups]));
    if (owned.users.size)
      await tx.delete(users).where(inArray(users.id, [...owned.users]));
  });
  owned.users.clear();
  owned.chats.clear();
  owned.groups.clear();
  owned.messages.clear();
  owned.participants.clear();
  owned.groupMembers.clear();
  owned.ledger.clear();
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
  const directMessageId = await generateSnowflakeId();
  owned.messages.add(directMessageId);
  await db.insert(messages).values({
    id: directMessageId,
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
  const backedMemberIds = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  for (const id of backedMemberIds) owned.groupMembers.add(id);
  await db.insert(groupMembers).values([
    {
      id: backedMemberIds[0],
      groupId,
      userId: viewer,
      role: 'owner',
      isActive: true,
      lastMessageAt: now,
    },
    {
      id: backedMemberIds[1],
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
    const dmParticipantIds = [
      await generateSnowflakeId(),
      await generateSnowflakeId(),
    ];
    for (const id of dmParticipantIds) owned.participants.add(id);
    await db.insert(chatParticipants).values([
      { id: dmParticipantIds[0], chatId, userId: viewer },
      { id: dmParticipantIds[1], chatId, userId: other },
    ]);
    const dmMessageId = await generateSnowflakeId();
    owned.messages.add(dmMessageId);
    await db.insert(messages).values({
      id: dmMessageId,
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
    const tiedMemberId = await generateSnowflakeId();
    owned.groupMembers.add(tiedMemberId);
    await db.insert(groupMembers).values({
      id: tiedMemberId,
      groupId: gid,
      userId: viewer,
      role: 'owner',
      isActive: true,
      lastMessageAt: tiedAt,
    });
  }
});

afterAll(async () => {
  const userIds = [...owned.users];
  await cleanupOwnedFixtures();

  // Cleanup evidence: nothing this fixture owned may remain behind.
  if (userIds.length) {
    const [ledgerLeft] = await db
      .select({ value: count() })
      .from(pointsTransactions)
      .where(inArray(pointsTransactions.userId, userIds));
    assert.equal(ledgerLeft?.value ?? 0, 0);
    const [usersLeft] = await db
      .select({ value: count() })
      .from(users)
      .where(inArray(users.id, userIds));
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
  const ownedLedgerId = await generateSnowflakeId();
  await db.insert(pointsTransactions).values({
    id: ownedLedgerId,
    userId: tempId,
    amount: 1,
    pointsBefore: 0,
    pointsAfter: 1,
    reason: 'private_channel_create',
  });
  // An unrecorded ledger row for the SAME owned user: the old user-scoped
  // delete would have removed it; the exact-id delete must not.
  const unrecordedLedgerId = await generateSnowflakeId();
  await db.insert(pointsTransactions).values({
    id: unrecordedLedgerId,
    userId: tempId,
    amount: 1,
    pointsBefore: 0,
    pointsAfter: 1,
    reason: 'private_channel_create',
  });

  await deleteLedgerRowsById([ownedLedgerId]);

  const [ownedRow] = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.id, ownedLedgerId));
  expect(ownedRow).toBeUndefined();
  const [unrecordedRow] = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.id, unrecordedLedgerId));
  expect(unrecordedRow).toBeDefined();
  const foreignLeft = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, foreignId));
  expect(foreignLeft.length).toBe(1);

  // The rows this test planted are its own: remove them explicitly so the
  // shared teardown scope check still passes.
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.id, unrecordedLedgerId));
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, foreignId));
  await db.delete(users).where(eq(users.id, foreignId));
});

test('G1: a direct group preview skips a message from a blocked sender', async () => {
  const blockId = await generateSnowflakeId();
  try {
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: viewer,
      blockedId: member1,
    });
    const list = await getList(viewer);
    const entry = list.groupChats.find((c) => c.id === directGroupChatId);
    assert.ok(entry);
    // The only message in this chat is from the blocked sender, so no
    // preview survives; the count still counts every message in the chat.
    expect(entry.lastMessage).toBeNull();
    expect(entry.messageCount).toBe(1);
    // DM previews are unchanged: the other participant is not blocked.
    const dm = list.directChats.find((c) => c.id === dmChatIds[0]);
    assert.ok(dm);
    expect(dm.lastMessage?.content).toBe('dm 0');
  } finally {
    await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
  }
});

test('F2: cleanup refuses unrecorded rows under owned parents', async () => {
  const tempId = await makeUser('refuse');
  const strayLedgerId = await generateSnowflakeId();
  await db.insert(pointsTransactions).values({
    id: strayLedgerId,
    userId: tempId,
    amount: 1,
    pointsBefore: 0,
    pointsAfter: 1,
    reason: 'private_channel_create',
  });
  const strayMessageId = await generateSnowflakeId();
  await db.insert(messages).values({
    id: strayMessageId,
    chatId: directGroupChatId,
    senderId: tempId,
    content: 'stray message',
    createdAt: new Date(),
  });

  let refused = false;
  try {
    await cleanupOwnedFixtures();
  } catch (error) {
    refused = /cleanup refused/.test((error as Error).message);
  }
  expect(refused).toBe(true);

  // Nothing was deleted: the stray rows survive the refused cleanup.
  const [ledgerRow] = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.id, strayLedgerId));
  expect(ledgerRow).toBeDefined();
  const [messageRow] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, strayMessageId));
  expect(messageRow).toBeDefined();

  // The planted rows are this test's own: remove them explicitly, then the
  // normal cleanup succeeds and removes the whole fixture.
  await db.delete(messages).where(eq(messages.id, strayMessageId));
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.id, strayLedgerId));
  await cleanupOwnedFixtures();
  const [usersLeft] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.id, tempId));
  expect(usersLeft?.value ?? 0).toBe(0);
});
