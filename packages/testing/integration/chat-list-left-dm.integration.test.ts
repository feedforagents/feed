/** PRD §12 / MVP phases3/5: existing active chat-membership read contract. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
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

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const owned = {
  users: new Set<string>(),
  keys: new Set<string>(),
  groups: new Set<string>(),
  chats: new Set<string>(),
  participants: new Set<string>(),
  members: new Set<string>(),
  messages: new Set<string>(),
};
const userIds = new Map<string, string>();
const chatIds = new Map<string, string>();
const groupIds = new Map<string, string>();
const tokens = new Map<string, string>();
const keys = new Map<string, string>();
let runId = '';
const lastMessage = z
  .object({ id: z.string(), content: z.string() })
  .nullable();
const listSchema = z.object({
  groupChats: z.array(
    z.object({
      id: z.string(),
      isGroup: z.literal(true),
      lastMessage,
      messageCount: z.number(),
    })
  ),
  directChats: z.array(
    z.object({
      id: z.string(),
      isGroup: z.literal(false),
      lastMessage,
      participants: z.number(),
      otherUser: z.object({
        id: z.string(),
        isAgent: z.boolean(),
        managedBy: z.string().nullable(),
      }),
    })
  ),
  total: z.number(),
});
function user(label: string) {
  const id = userIds.get(label);
  if (!id) throw new Error('Missing user ' + label);
  return id;
}
function chat(label: string) {
  const id = chatIds.get(label);
  if (!id) throw new Error('Missing chat ' + label);
  return id;
}
function auth(label = 'viewer', cookie = false): Record<string, string> {
  const token = tokens.get(label);
  if (!token) throw new Error('Missing token ' + label);
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
    signal: AbortSignal.timeout(15_000),
  });
}
async function list(label = 'viewer', cookie = false, suffix = '') {
  const response = await request('/api/chats' + suffix, auth(label, cookie));
  expect(response.status).toBe(200);
  const result = listSchema.parse(await response.json());
  expect(result.total).toBe(
    result.groupChats.length + result.directChats.length
  );
  return result;
}
async function detail(label: string, target: string, status: number) {
  const response = await request(`/api/chats/${chat(target)}`, auth(label));
  expect(response.status).toBe(status);
  return response.json();
}
async function tool(label: string, name: string, args: Record<string, string>) {
  const key = keys.get(label);
  if (!key) throw new Error('Missing owned API key');
  const id = await generateSnowflakeId();
  const response = await request(
    '/api/mcp',
    { 'X-Feed-Api-Key': key },
    'POST',
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
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
  return JSON.parse(envelope.result.content[0]!.text);
}
async function makeChat(
  label: string,
  participants: Array<[string, boolean]>,
  groupLabel?: string
) {
  const id = await generateSnowflakeId();
  const groupId = groupLabel ? groupIds.get(groupLabel) : undefined;
  const inserted = await db
    .insert(chats)
    .values({
      id,
      name: groupLabel ? 'Group ' + label : null,
      isGroup: !!groupLabel,
      groupId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: chats.id });
  for (const row of inserted) owned.chats.add(row.id);
  chatIds.set(label, id);
  const rows: Array<typeof chatParticipants.$inferInsert> = [];
  for (const [who, isActive] of participants)
    rows.push({
      id: await generateSnowflakeId(),
      chatId: id,
      userId: user(who),
      isActive,
    });
  const added = await db
    .insert(chatParticipants)
    .values(rows)
    .returning({ id: chatParticipants.id });
  for (const row of added) owned.participants.add(row.id);
  const sent = await db
    .insert(messages)
    .values({
      id: await generateSnowflakeId(),
      chatId: id,
      senderId: user('peer'),
      content: `${runId} ${label} latest`,
      createdAt: new Date(Date.now() - 1000),
    })
    .returning({ id: messages.id });
  for (const row of sent) owned.messages.add(row.id);
}
beforeAll(async () => {
  runId = await generateSnowflakeId();
  const labels = [
    'viewer',
    'peer',
    'outsider',
    'onlyleft',
    'actor',
    'ownagent',
    'otheragent',
  ];
  const rows: Array<typeof users.$inferInsert> = [];
  for (const label of labels) userIds.set(label, await generateSnowflakeId());
  for (const label of labels)
    rows.push({
      id: user(label),
      username: `p1684_${label}_${runId.slice(-10)}`,
      displayName: 'Chat fixture ' + label,
      stewardId: `p1684-${user(label)}`,
      isActor: label === 'actor',
      isAgent: label === 'ownagent' || label === 'otheragent',
      managedBy:
        label === 'ownagent'
          ? user('viewer')
          : label === 'otheragent'
            ? user('outsider')
            : null,
      virtualBalance: label === 'peer' ? '222' : '111',
      updatedAt: new Date(),
    });
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
  for (const label of ['viewer', 'peer', 'outsider', 'onlyleft'])
    tokens.set(label, await createStewardTestToken(`p1684-${user(label)}`));
  for (const label of ['viewer', 'peer']) {
    const key = generateApiKey();
    const inserted = await db
      .insert(userApiKeys)
      .values({
        id: await generateSnowflakeId(),
        userId: user(label),
        name: 'Temporary chat regression key',
        keyHash: hashApiKey(key),
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning({ id: userApiKeys.id });
    for (const row of inserted) owned.keys.add(row.id);
    keys.set(label, key);
  }
  for (const label of ['activegroup', 'leftgroup', 'team']) {
    const id = await generateSnowflakeId();
    const inserted = await db
      .insert(groups)
      .values({
        id,
        name: `p1684 ${label}`,
        type: label === 'team' ? 'team' : 'user',
        ownerId: label === 'team' ? user('viewer') : user('peer'),
        createdById: user('peer'),
        updatedAt: new Date(),
      })
      .returning({ id: groups.id });
    for (const row of inserted) owned.groups.add(row.id);
    groupIds.set(label, id);
    const members: Array<typeof groupMembers.$inferInsert> = [];
    for (const who of ['viewer', 'peer'])
      members.push({
        id: await generateSnowflakeId(),
        groupId: id,
        userId: user(who),
        role:
          who === (label === 'team' ? 'viewer' : 'peer') ? 'owner' : 'member',
        isActive: label !== 'leftgroup' || who !== 'viewer',
        messageCount: 3,
        lastMessageAt: new Date(Date.now() - 1000),
      });
    const added = await db
      .insert(groupMembers)
      .values(members)
      .returning({ id: groupMembers.id });
    for (const row of added) owned.members.add(row.id);
  }
  for (const [label, participants] of [
    [
      'active',
      [
        ['viewer', true],
        ['peer', true],
      ],
    ],
    [
      'left',
      [
        ['viewer', false],
        ['peer', true],
      ],
    ],
    [
      'peerleft',
      [
        ['viewer', true],
        ['peer', false],
      ],
    ],
    [
      'leave',
      [
        ['viewer', true],
        ['peer', true],
      ],
    ],
    [
      'onlyleft',
      [
        ['onlyleft', false],
        ['peer', true],
      ],
    ],
    [
      'actor',
      [
        ['viewer', true],
        ['actor', true],
      ],
    ],
    [
      'ownagent',
      [
        ['viewer', true],
        ['ownagent', true],
      ],
    ],
    [
      'otheragent',
      [
        ['viewer', true],
        ['otheragent', true],
      ],
    ],
    [
      'outsider',
      [
        ['outsider', true],
        ['peer', true],
      ],
    ],
  ] as Array<[string, Array<[string, boolean]>]>)
    await makeChat(label, participants);
  for (const label of ['activegroup', 'leftgroup', 'team'])
    await makeChat(
      label,
      [
        ['viewer', label !== 'leftgroup'],
        ['peer', true],
      ],
      label
    );
}, 30_000);
afterAll(async () => {
  const cleanup: Record<
    string,
    { inserted: number; removed: number; remaining: number }
  > = {};
  try {
    for (const [kind, table] of [
      ['messages', messages],
      ['participants', chatParticipants],
      ['members', groupMembers],
      ['chats', chats],
      ['groups', groups],
      ['keys', userApiKeys],
      ['users', users],
    ] as const) {
      const ids = [...owned[kind]];
      const removed = ids.length
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
      cleanup[kind] = {
        inserted: ids.length,
        removed: removed.length,
        remaining,
      };
      expect(remaining).toBe(0);
    }
  } finally {
    console.log('PR1684_CHAT_CLEANUP', JSON.stringify({ runId, cleanup }));
    await db.$disconnect();
  }
});
describe('actual HTTP active viewer memberships in chat list', () => {
  it('keeps active DMs and existing peer/actor/managed-agent rules', async () => {
    const result = await list();
    const ids = result.directChats.map((row) => row.id);
    expect(ids.sort()).toEqual(
      ['active', 'peerleft', 'leave', 'otheragent'].map(chat).sort()
    );
    const active = result.directChats.find((row) => row.id === chat('active'));
    expect(active?.lastMessage?.content).toBe(`${runId} active latest`);
    expect(active?.participants).toBe(2);
    expect(active?.otherUser.id).toBe(user('peer'));
    expect(ids).not.toContain(chat('actor'));
    expect(ids).not.toContain(chat('ownagent'));
  });
  it('omits inactive viewer memberships and their previews, including left-only accounts', async () => {
    const result = await list();
    expect(result.directChats.map((row) => row.id)).not.toContain(chat('left'));
    expect(JSON.stringify(result)).not.toContain(`${runId} left latest`);
    const empty = await list('onlyleft');
    expect(empty.directChats).toEqual([]);
    expect(empty.groupChats).toEqual([]);
    expect(empty.total).toBe(0);
    await detail('viewer', 'left', 403);
  });
  it('keeps group membership and team exclusions separate from DMs', async () => {
    const result = await list();
    expect(result.groupChats.map((row) => row.id)).toEqual([
      chat('activegroup'),
    ]);
    expect(result.groupChats[0]?.messageCount).toBe(3);
    expect(result.groupChats[0]?.lastMessage?.content).toBe(
      `${runId} activegroup latest`
    );
    const peer = await list('peer');
    expect(peer.groupChats.map((row) => row.id).sort()).toEqual(
      ['activegroup', 'leftgroup', 'team'].map(chat).sort()
    );
  });
  it('binds Bearer/cookie identity and keeps caller lists/details isolated', async () => {
    for (const cookie of [false, true]) {
      const response = await request('/api/users/me', auth('viewer', cookie));
      expect(response.status).toBe(200);
      expect(
        z
          .object({ user: z.object({ id: z.string() }) })
          .parse(await response.json()).user.id
      ).toBe(user('viewer'));
    }
    const outsider = await list('outsider', false, `?userId=${user('viewer')}`);
    expect(outsider.directChats.map((row) => row.id)).toEqual([
      chat('outsider'),
    ]);
    await detail('outsider', 'active', 403);
    const peer = await list('peer');
    expect(peer.directChats.map((row) => row.id)).toContain(chat('left'));
  });
  it('rejects missing/invalid web and MCP credentials through production boundaries', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer invalid-token' },
    ] as Array<Record<string, string>>) {
      const response = await request('/api/chats', headers);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    for (const key of ['', generateApiKey()]) {
      const response = await request(
        '/api/mcp',
        key ? { 'X-Feed-Api-Key': key } : {},
        'POST',
        {
          jsonrpc: '2.0',
          id: 'negative',
          method: 'tools/call',
          params: { name: 'leave_chat', arguments: { chatId: chat('leave') } },
        }
      );
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  });
  it('reflects a real keyed MCP leave in list/detail while retaining the other caller', async () => {
    expect(
      z
        .object({ balance: z.literal('111.00') })
        .parse(await tool('viewer', 'get_balance', {})).balance
    ).toBe('111.00');
    expect(
      z
        .object({ balance: z.literal('222.00') })
        .parse(await tool('peer', 'get_balance', {})).balance
    ).toBe('222.00');
    await detail('viewer', 'leave', 200);
    expect(
      z
        .object({ success: z.literal(true) })
        .parse(await tool('viewer', 'leave_chat', { chatId: chat('leave') }))
        .success
    ).toBe(true);
    const after = await list();
    expect(after.directChats.map((row) => row.id)).not.toContain(chat('leave'));
    expect(JSON.stringify(after)).not.toContain(`${runId} leave latest`);
    await detail('viewer', 'leave', 403);
    expect((await list('peer')).directChats.map((row) => row.id)).toContain(
      chat('leave')
    );
    const membership = await db
      .select({
        id: chatParticipants.id,
        userId: chatParticipants.userId,
        isActive: chatParticipants.isActive,
      })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chat('leave')));
    expect(
      membership.find((row) => row.userId === user('viewer'))?.isActive
    ).toBe(false);
    expect(
      membership.find((row) => row.userId === user('peer'))?.isActive
    ).toBe(true);
    const viewer = membership.find((row) => row.userId === user('viewer'));
    if (!viewer || !owned.participants.has(viewer.id))
      throw new Error('Expected owned membership');
    await db
      .update(chatParticipants)
      .set({ isActive: true })
      .where(eq(chatParticipants.id, viewer.id));
    expect((await list()).directChats.map((row) => row.id)).toContain(
      chat('leave')
    );
    await detail('viewer', 'leave', 200);
  });
  it('keeps all=true restricted to its existing public game-chat contract', async () => {
    const response = await request('/api/chats?all=true');
    expect(response.status).toBe(200);
    const result = z
      .object({ chats: z.array(z.object({ id: z.string() })) })
      .parse(await response.json());
    expect(result.chats.every((row) => !owned.chats.has(row.id))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(runId);
  });
  it('does not acquire cleanup ownership from a colliding failed batch', async () => {
    const id = await generateSnowflakeId();
    const inserted = await db
      .insert(users)
      .values({ id, username: `p1684_partial_${id}`, updatedAt: new Date() })
      .returning({ id: users.id });
    for (const row of inserted) owned.users.add(row.id);
    const failed: string[] = [];
    await expect(
      (async () => {
        const rows = await db
          .insert(users)
          .values([
            {
              id: user('viewer'),
              username: `p1684_collision_${id}`,
              updatedAt: new Date(),
            },
            {
              id: await generateSnowflakeId(),
              username: `p1684_rollback_${id}`,
              updatedAt: new Date(),
            },
          ])
          .returning({ id: users.id });
        failed.push(...rows.map((row) => row.id));
      })()
    ).rejects.toThrow();
    expect(failed).toEqual([]);
    const [viewer] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, user('viewer')));
    expect(viewer?.username).toBe(`p1684_viewer_${runId.slice(-10)}`);
  });
});
