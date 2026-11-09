/** PRD §§9.5/12, MVP1: deterministic group selector, not live NPC/LLM proof. */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { generateApiKey, hashApiKey } from '@feed/api';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const { getAgentGroupChats } = await import(
  '../../agents/src/autonomous/utils/context-gatherers'
);
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const target = new URL(base);
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
  keys: new Set<string>(),
  groups: new Set<string>(),
  chats: new Set<string>(),
  members: new Set<string>(),
  participants: new Set<string>(),
  messages: new Set<string>(),
};
const userIds = new Map<string, string>(),
  groupIds = new Map<string, string>(),
  chatIds = new Map<string, string>(),
  memberIds = new Map<string, string>(),
  participantIds = new Map<string, string>(),
  tokens = new Map<string, string>();
let runId = '',
  key = '',
  kickAttempted = false;
function from(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error('Missing owned fixture ' + label);
  return value;
}
const user = (label: string) => from(userIds, label),
  chat = (label: string) => from(chatIds, label),
  group = (label: string) => from(groupIds, label),
  name = (label: string) => `${runId} ${label}`;
function auth(label = 'subject', cookie = false): Record<string, string> {
  const token = from(tokens, label);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}
async function request(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: object
) {
  return fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}
async function status(
  path: string,
  label: string,
  expected: number,
  method = 'GET',
  body?: object
) {
  const response = await request(path, auth(label), method, body);
  expect(response.status).toBe(expected);
  await response.arrayBuffer();
}
async function selected(label = 'subject') {
  return getAgentGroupChats(user(label));
}
async function one(label: string, who = 'subject') {
  return (await selected(who)).find((row) => row.id === chat(label));
}
async function captureKickMessage() {
  if (!kickAttempted || !owned.chats.has(chat('kick'))) return;
  // The successful owned HTTP mutation does not return its system-message ID.
  // Its new owned chat + exact run-unique content identify only that side effect.
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chat('kick')),
        eq(messages.senderId, 'system'),
        eq(
          messages.content,
          `${name('owner')} removed ${name('subject')} from the group`
        )
      )
    );
  for (const row of rows) owned.messages.add(row.id);
}
async function makeChat(
  label: string,
  kind: 'user' | 'team' | 'dm',
  entries: Array<[string, boolean]>,
  owner = 'owner'
) {
  const now = new Date();
  let groupId: string | null = null;
  if (kind !== 'dm') {
    groupId = await generateSnowflakeId();
    const rows = await db
      .insert(groups)
      .values({
        id: groupId,
        name: name(label),
        type: kind,
        ownerId: user(owner),
        createdById: user(owner),
        updatedAt: now,
      })
      .returning({ id: groups.id });
    for (const row of rows) owned.groups.add(row.id);
    groupIds.set(label, groupId);
  }
  const id = await generateSnowflakeId();
  for (const row of await db
    .insert(chats)
    .values({
      id,
      name: name(label),
      isGroup: kind !== 'dm',
      groupId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: chats.id }))
    owned.chats.add(row.id);
  chatIds.set(label, id);
  const participants: Array<typeof chatParticipants.$inferInsert> = [],
    members: Array<typeof groupMembers.$inferInsert> = [];
  for (const [who, active] of entries) {
    const participantId = await generateSnowflakeId();
    participantIds.set(label + ':' + who, participantId);
    participants.push({
      id: participantId,
      chatId: id,
      userId: user(who),
      isActive: active,
      joinedAt: now,
    });
    if (groupId) {
      const memberId = await generateSnowflakeId();
      memberIds.set(label + ':' + who, memberId);
      members.push({
        id: memberId,
        groupId,
        userId: user(who),
        role: who === owner ? 'owner' : 'member',
        isActive: active,
        joinedAt: now,
      });
    }
  }
  for (const row of await db
    .insert(chatParticipants)
    .values(participants)
    .returning({ id: chatParticipants.id }))
    owned.participants.add(row.id);
  if (members.length)
    for (const row of await db
      .insert(groupMembers)
      .values(members)
      .returning({ id: groupMembers.id }))
      owned.members.add(row.id);
}
beforeAll(async () => {
  runId = await generateSnowflakeId();
  const rows: Array<typeof users.$inferInsert> = [];
  for (const label of [
    'subject',
    'owner',
    'departed',
    'peer',
    'outsider',
    'cap',
    'onlyleft',
  ]) {
    const id = await generateSnowflakeId();
    userIds.set(label, id);
    rows.push({
      id,
      username: `p1689_${label}_${runId.slice(-10)}`,
      displayName: name(label),
      stewardId: `p1689-${id}`,
      updatedAt: new Date(),
    });
  }
  for (const row of await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id }))
    owned.users.add(row.id);
  for (const label of ['subject', 'owner', 'peer', 'outsider'])
    tokens.set(label, await createStewardTestToken(`p1689-${user(label)}`));
  key = generateApiKey();
  for (const row of await db
    .insert(userApiKeys)
    .values({
      id: await generateSnowflakeId(),
      userId: user('subject'),
      name: 'Owned group selector test key',
      keyHash: hashApiKey(key),
      expiresAt: new Date(Date.now() + 3600000),
    })
    .returning({ id: userApiKeys.id }))
    owned.keys.add(row.id);
  await makeChat('stay', 'user', [
    ['subject', true],
    ['owner', true],
    ['peer', true],
    ['departed', false],
  ]);
  await makeChat('left', 'user', [
    ['subject', false],
    ['owner', true],
    ['onlyleft', false],
  ]);
  await makeChat('leave', 'user', [
    ['subject', true],
    ['owner', true],
    ['peer', true],
  ]);
  await makeChat('kick', 'user', [
    ['subject', true],
    ['owner', true],
    ['peer', true],
  ]);
  await makeChat('team', 'team', [
    ['subject', true],
    ['owner', true],
  ]);
  await makeChat('dm', 'dm', [
    ['subject', true],
    ['owner', true],
  ]);
  await makeChat('unrelated', 'user', [
    ['outsider', true],
    ['owner', true],
  ]);
  for (let index = 0; index < 6; index++)
    await makeChat('cap' + index, 'user', [['cap', true]], 'cap');
});
afterAll(async () => {
  const cleanup: Record<
    string,
    { owned: number; removed: number; remaining: number }
  > = {};
  try {
    await captureKickMessage();
    for (const [kind, table] of [
      ['keys', userApiKeys],
      ['messages', messages],
      ['participants', chatParticipants],
      ['members', groupMembers],
      ['chats', chats],
      ['groups', groups],
      ['users', users],
    ] as const) {
      const ids = [...owned[kind]],
        removed = ids.length
          ? await db
              .delete(table)
              .where(inArray(table.id, ids))
              .returning({ id: table.id })
          : [];
      const remaining = ids.length
        ? (
            await db
              .select({ id: table.id })
              .from(table)
              .where(inArray(table.id, ids))
          ).length
        : 0;
      cleanup[kind] = { owned: ids.length, removed: removed.length, remaining };
      expect(remaining).toBe(0);
    }
  } finally {
    console.log(
      'PR1689_SELECTOR_CLEANUP',
      JSON.stringify({
        runId,
        cleanup,
        ownedOnly: true,
        serverOnlyMarkerStub: true,
        npcTickExecuted: false,
        llmCalls: 0,
      })
    );
    await db.$disconnect();
  }
});
describe('actual local production group selector and HTTP membership transitions', () => {
  it('keeps active groups and counts only active participants', async () => {
    expect((await one('stay'))?.memberCount).toBe(3);
    expect((await one('leave'))?.memberCount).toBe(3);
    expect((await selected()).map((row) => row.id).sort()).toEqual(
      ['stay', 'leave', 'kick'].map(chat).sort()
    );
  });
  it('excludes inactive self membership, team chats, DMs and unrelated callers', async () => {
    const ids = (await selected()).map((row) => row.id);
    for (const label of ['left', 'team', 'dm', 'unrelated'])
      expect(ids).not.toContain(chat(label));
    expect(await selected('onlyleft')).toEqual([]);
    const other = await selected('outsider');
    expect(other.map((row) => row.id)).toEqual([chat('unrelated')]);
    expect(other[0]?.memberCount).toBe(2);
  });
  it('observes real per-user-key MCP leave and controlled owned-row reactivation', async () => {
    await status(`/api/chats/${chat('leave')}`, 'subject', 200);
    const id = await generateSnowflakeId();
    try {
      const response = await request(
        '/api/mcp',
        { 'X-Feed-Api-Key': key },
        'POST',
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'leave_chat', arguments: { chatId: chat('leave') } },
        }
      );
      expect(response.status).toBe(200);
      const envelope = z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.literal(id),
          result: z.object({
            isError: z.literal(false),
            content: z
              .array(z.object({ type: z.literal('text'), text: z.string() }))
              .length(1),
          }),
        })
        .parse(await response.json());
      expect(
        z
          .object({ success: z.literal(true) })
          .parse(JSON.parse(envelope.result.content[0]!.text)).success
      ).toBe(true);
      const [participant] = await db
        .select({ active: chatParticipants.isActive })
        .from(chatParticipants)
        .where(eq(chatParticipants.id, from(participantIds, 'leave:subject')));
      const [member] = await db
        .select({ active: groupMembers.isActive })
        .from(groupMembers)
        .where(eq(groupMembers.id, from(memberIds, 'leave:subject')));
      expect(participant?.active).toBe(false);
      expect(member?.active).toBe(false);
      expect(await one('leave')).toBeUndefined();
      expect((await one('leave', 'owner'))?.memberCount).toBe(2);
      await status(`/api/chats/${chat('leave')}`, 'subject', 403);
      await status(`/api/chats/${chat('leave')}`, 'peer', 200);
      await status(
        `/api/chats/${chat('leave')}/messages`,
        'subject',
        403,
        'POST',
        { content: name('denied-after-leave') }
      );
    } finally {
      const participantId = from(participantIds, 'leave:subject'),
        memberId = from(memberIds, 'leave:subject');
      if (owned.participants.has(participantId))
        await db
          .update(chatParticipants)
          .set({ isActive: true })
          .where(eq(chatParticipants.id, participantId));
      if (owned.members.has(memberId))
        await db
          .update(groupMembers)
          .set({ isActive: true, kickedAt: null, kickReason: null })
          .where(eq(groupMembers.id, memberId));
    }
    expect((await one('leave'))?.memberCount).toBe(3);
    await status(`/api/chats/${chat('leave')}`, 'subject', 200);
  });
  it('enforces real HTTP owner removal and retains active peer context', async () => {
    await status(
      `/api/groups/${group('kick')}/members?userId=${user('subject')}`,
      'outsider',
      403,
      'DELETE'
    );
    expect((await one('kick'))?.memberCount).toBe(3);
    kickAttempted = true;
    try {
      await status(
        `/api/groups/${group('kick')}/members?userId=${user('subject')}`,
        'owner',
        200,
        'DELETE'
      );
    } finally {
      await captureKickMessage();
    }
    expect(owned.messages.size).toBe(1);
    expect(
      (
        await db
          .select({ id: chatParticipants.id })
          .from(chatParticipants)
          .where(eq(chatParticipants.id, from(participantIds, 'kick:subject')))
      ).length
    ).toBe(0);
    const [member] = await db
      .select({ active: groupMembers.isActive })
      .from(groupMembers)
      .where(eq(groupMembers.id, from(memberIds, 'kick:subject')));
    expect(member?.active).toBe(false);
    expect(await one('kick')).toBeUndefined();
    expect((await one('kick', 'owner'))?.memberCount).toBe(2);
    await status(`/api/chats/${chat('kick')}`, 'subject', 403);
    await status(`/api/chats/${chat('kick')}`, 'peer', 200);
    await status(
      `/api/chats/${chat('kick')}/messages`,
      'subject',
      403,
      'POST',
      { content: name('denied-after-kick') }
    );
  });
  it('binds normal Bearer/cookie identity and rejects missing or invalid authentication', async () => {
    for (const cookie of [false, true]) {
      const response = await request('/api/users/me', auth('subject', cookie));
      expect(response.status).toBe(200);
      expect(
        z
          .object({ user: z.object({ id: z.string() }) })
          .parse(await response.json()).user.id
      ).toBe(user('subject'));
    }
    for (const headers of [
      {},
      { authorization: 'Bearer invalid-token' },
    ] as Array<Record<string, string>>) {
      const response = await request(`/api/chats/${chat('stay')}`, headers);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  });
  it('preserves the top-five cap without claiming a new ordering or team-selection policy', async () => {
    const result = await selected('cap');
    expect(result).toHaveLength(5);
    const candidates = new Set(
      Array.from({ length: 6 }, (_, index) => chat('cap' + index))
    );
    expect(new Set(result.map((row) => row.id)).size).toBe(5);
    expect(
      result.every((row) => candidates.has(row.id) && row.memberCount === 1)
    ).toBe(true);
  });
  it('does not gain teardown ownership from a duplicate-key setup failure', async () => {
    const id = await generateSnowflakeId();
    for (const row of await db
      .insert(users)
      .values({ id, username: `p1689_partial_${id}`, updatedAt: new Date() })
      .returning({ id: users.id }))
      owned.users.add(row.id);
    const failed: string[] = [];
    await expect(
      (async () => {
        const rows = await db
          .insert(users)
          .values({
            id: user('subject'),
            username: `p1689_collision_${id}`,
            updatedAt: new Date(),
          })
          .returning({ id: users.id });
        failed.push(...rows.map((row) => row.id));
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(failed).toEqual([]);
    expect(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user('subject')))
      ).length
    ).toBe(1);
  });
});
