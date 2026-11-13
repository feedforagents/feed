/**
 * PRD §§8.1/12, retained MVP Phase 5: explicit messaging must reach the intended
 * identity. This exercises the real action handler and database, after a real
 * authenticated SDK request. It does not exercise model extraction/selection,
 * the runtime's parameter metadata, OAuth, or a new DM blocking policy.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import { AgentRuntime, type Memory, type State } from '@elizaos/core';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  chatParticipants,
  chats,
  dbWrite as db,
  dmAcceptances,
  sql,
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { sendMessageAction } from '../../agents/src/plugins/feed/actions/messaging';
import { FeedA2AClient } from '../../agents/src/plugins/feed/integration-a2a-sdk';
import type { FeedRuntime } from '../../agents/src/plugins/feed/types';

const base = new URL(
  process.env.TEST_API_URL ||
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3100'
);
type Table =
  | 'User'
  | 'UserApiKey'
  | 'Chat'
  | 'ChatParticipant'
  | 'DMAcceptance'
  | 'Message';
type Receipt = { id: string; canonical: string };
const owned: Record<Table, Map<string, Receipt>> = {
  User: new Map(),
  UserApiKey: new Map(),
  Chat: new Map(),
  ChatParticipant: new Map(),
  DMAcceptance: new Map(),
  Message: new Map(),
};
const ids = new Map<string, string>();
let username = '';
let ambiguous = '';
let rawKey = '';
let firstUse = '';
let runtime: FeedRuntime;
let memory: Memory;

function id(label: string) {
  const value = ids.get(label);
  assert.ok(value, `Missing fixture ${label}`);
  return value;
}
function acquire(target: typeof owned, table: Table, rows: Receipt[]) {
  for (const row of rows) {
    assert.ok(row.id && row.canonical, 'Incomplete physical RETURNING');
    assert.ok(!target[table].has(row.id), 'Duplicate receipt');
    target[table].set(row.id, row);
  }
}
function state(params: Record<string, string>): State {
  return { values: {}, data: { actionParams: params }, text: '' };
}
async function invoke(
  params?: Record<string, string>,
  legacy?: Record<string, string>,
  caller = runtime
) {
  return sendMessageAction.handler(
    caller,
    memory,
    legacy ? state(legacy) : undefined,
    params ? { parameters: params } : undefined
  );
}

// Every SDK request stays on the explicitly configured disposable local server.
// No redirect or card-advertised external origin may receive this synthetic key.
const sdkFetch: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    assert.equal(url.origin, base.origin, 'Off-origin SDK request');
    assert.ok(
      ['/.well-known/agent-card.json', '/api/a2a'].includes(url.pathname)
    );
    const headers = new Headers(init?.headers);
    headers.set('x-feed-api-key', rawKey);
    headers.set('x-agent-id', id('sender'));
    return fetch(input, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  },
  { preconnect: fetch.preconnect }
);

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/feed_pr\d+$/);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(process.env.DIRECT_DATABASE_URL, process.env.DATABASE_URL);
  assert.ok(!process.env.DATABASE_READ_REPLICA_URL?.trim());
  assert.ok(
    !process.env.FEED_A2A_TRANSPORT || process.env.FEED_A2A_TRANSPORT === 'http'
  );
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  for (const label of [
    'sender',
    'target',
    'wrong',
    'duplicate1',
    'duplicate2',
    'outsider',
    'correctChat',
    'wrongChat',
    'foreignChat',
    'inactiveChat',
  ]) {
    const value = await generateSnowflakeId();
    assert.ok(isValidSnowflakeId(value));
    ids.set(label, value);
  }
  username = `MiXeD_${id('target')}`;
  ambiguous = `DuPe_${id('duplicate1')}`;
  rawKey = generateApiKey();
  const pending: typeof owned = {
    User: new Map(),
    UserApiKey: new Map(),
    Chat: new Map(),
    ChatParticipant: new Map(),
    DMAcceptance: new Map(),
    Message: new Map(),
  };
  await db.transaction(async (tx) => {
    const now = new Date();
    acquire(
      pending,
      'User',
      await tx
        .insert(users)
        .values(
          [
            'sender',
            'target',
            'wrong',
            'duplicate1',
            'duplicate2',
            'outsider',
          ].map((label) => ({
            id: id(label),
            username:
              label === 'target'
                ? username
                : label === 'duplicate1'
                  ? ambiguous
                  : label === 'duplicate2'
                    ? ambiguous.toUpperCase()
                    : `dm_${id(label)}`,
            isAgent: label === 'sender',
            isActor: false,
            virtualBalance: label === 'sender' ? '1777.00' : '8888.00',
            updatedAt: now,
          }))
        )
        .returning({
          id: users.id,
          canonical: sql<string>`to_jsonb(${users})::text`,
        })
    );
    for (const [label, left, right, active] of [
      ['correctChat', 'sender', 'target', true],
      ['wrongChat', 'sender', 'wrong', true],
      ['foreignChat', 'wrong', 'outsider', true],
      ['inactiveChat', 'sender', 'outsider', false],
    ] as const) {
      acquire(
        pending,
        'Chat',
        await tx
          .insert(chats)
          .values({
            id: id(label),
            isGroup: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: chats.id,
            canonical: sql<string>`to_jsonb(${chats})::text`,
          })
      );
      acquire(
        pending,
        'ChatParticipant',
        await tx
          .insert(chatParticipants)
          .values([
            {
              id: await generateSnowflakeId(),
              chatId: id(label),
              userId: id(left),
              isActive: active,
              joinedAt: now,
            },
            {
              id: await generateSnowflakeId(),
              chatId: id(label),
              userId: id(right),
              isActive: true,
              joinedAt: now,
            },
          ])
          .returning({
            id: chatParticipants.id,
            canonical: sql<string>`to_jsonb(${chatParticipants})::text`,
          })
      );
      acquire(
        pending,
        'DMAcceptance',
        await tx
          .insert(dmAcceptances)
          .values({
            id: await generateSnowflakeId(),
            chatId: id(label),
            userId: id(right),
            otherUserId: id(left),
            status: 'accepted',
            createdAt: now,
            acceptedAt: now,
          })
          .returning({
            id: dmAcceptances.id,
            canonical: sql<string>`to_jsonb(${dmAcceptances})::text`,
          })
      );
    }
    acquire(
      pending,
      'UserApiKey',
      await tx
        .insert(userApiKeys)
        .values({
          id: await generateSnowflakeId(),
          userId: id('sender'),
          keyHash: hashApiKey(rawKey),
          name: 'Owned SEND_MESSAGE component',
          createdAt: now,
        })
        .returning({
          id: userApiKeys.id,
          canonical: sql<string>`to_jsonb(${userApiKeys})::text`,
        })
    );
  });
  for (const table of Object.keys(owned) as Table[])
    acquire(owned, table, [...pending[table].values()]);
  firstUse = new Date().toISOString();
  const sdk = await A2AClient.fromCardUrl(
    new URL('/.well-known/agent-card.json', base).href,
    { fetchImpl: sdkFetch }
  );
  const client = new FeedA2AClient(sdk, id('sender'), {
    agentUserId: id('sender'),
    displayName: null,
    cachedAt: Date.now(),
  });
  // isConnected() only checks for an SDK object: this actual protected request
  // separately proves the stored key reaches the expected account.
  expect(
    z.object({ balance: z.number() }).parse(await client.getBalance()).balance
  ).toBe(1777);
  runtime = new AgentRuntime({ agentId: randomUUID() });
  runtime.a2aClient = client;
  memory = {
    agentId: runtime.agentId,
    entityId: randomUUID(),
    roomId: randomUUID(),
    content: { text: 'Unrelated prose must never become message content' },
  };
});

async function messagingSnapshot() {
  const userIds = [...owned.User.keys()];
  const userList = sql.join(
    userIds.map((userId) => sql`${userId}`),
    sql`, `
  );
  const rows = await db.execute<{ table: string; canonical: string }>(sql`
    SELECT 'Chat' AS "table", to_jsonb(c)::text AS canonical FROM "Chat" c
      WHERE c.id IN (SELECT p."chatId" FROM "ChatParticipant" p WHERE p."userId" IN (${userList}))
    UNION ALL SELECT 'ChatParticipant', to_jsonb(p)::text FROM "ChatParticipant" p
      WHERE p."userId" IN (${userList})
    UNION ALL SELECT 'DMAcceptance', to_jsonb(a)::text FROM "DMAcceptance" a
      WHERE a."userId" IN (${userList}) OR a."otherUserId" IN (${userList})
    UNION ALL SELECT 'Message', to_jsonb(m)::text FROM "Message" m
      WHERE m."senderId" IN (${userList})
    ORDER BY "table", canonical
  `);
  return Array.from(rows);
}
async function expectNoWrites(
  operation: () => Promise<unknown>,
  error: RegExp
) {
  const before = await messagingSnapshot();
  await expect(operation()).rejects.toThrow(error);
  expect(await messagingSnapshot()).toEqual(before);
}
async function deliver(
  params?: Record<string, string>,
  legacy?: Record<string, string>
) {
  const result = await invoke(params, legacy);
  const parsed = z
    .object({
      success: z.literal(true),
      data: z.object({ messageId: z.string(), recipientId: z.string() }),
    })
    .parse(result);
  assert.ok(!owned.Message.has(parsed.data.messageId));
  const rows = await db.execute<
    Receipt & { senderId: string; chatId: string; content: string }
  >(sql`
    SELECT id, to_jsonb(m)::text AS canonical, "senderId", "chatId", content FROM "Message" m WHERE id = ${parsed.data.messageId}
  `);
  const row = rows[0];
  assert.ok(row && rows.length === 1);
  assert.equal(row.senderId, id('sender'));
  // These are only the two explicitly requested outcomes of this own call.
  // Capturing a baseline's wrong-state outcome enables safe failed-arm cleanup;
  // the business assertions below still reject delivery to the wrong account.
  assert.ok([id('correctChat'), id('wrongChat')].includes(row.chatId));
  assert.ok([params?.content, legacy?.content].includes(row.content));
  acquire(owned, 'Message', [row]);
  expect(parsed.data.recipientId).toBe(id('target'));
  expect(row.chatId).toBe(id('correctChat'));
  const expectedContent = params?.content ?? legacy?.content;
  assert.ok(expectedContent !== undefined);
  expect(row.content).toBe(expectedContent);
}

test('SDK explicit parameters override stale action state and deliver all case variants to the same user', async () => {
  for (const name of [
    username.toLowerCase(),
    username.toUpperCase(),
    `@${username}`,
  ]) {
    await deliver(
      { username: name, content: `Exact explicit content ${name}` },
      {
        username: `dm_${id('wrong')}`,
        content: 'Stale state must not be delivered',
      }
    );
  }
});
test('retains the existing explicit state caller when SDK parameters are absent', async () => {
  await deliver(undefined, {
    username,
    content: 'Exact legacy explicit content',
  });
});
test('ambiguous and unknown usernames create no chat, participant, acceptance or message', async () => {
  await expectNoWrites(
    () =>
      invoke({
        username: ambiguous.toLowerCase(),
        content: 'No ambiguous delivery',
      }),
    /Ambiguous username/
  );
  await expectNoWrites(
    () =>
      invoke({
        username: `missing_${id('sender')}`,
        content: 'No unknown delivery',
      }),
    /Recipient not found/
  );
});
test('missing connection and invalid SDK parameters cannot fall back to a valid destination', async () => {
  const disconnected: FeedRuntime = new AgentRuntime({ agentId: randomUUID() });
  await expectNoWrites(
    () =>
      invoke({ username, content: 'Not connected' }, undefined, disconnected),
    /active connection/
  );
  disconnected.a2aClient = new FeedA2AClient(null, id('sender'), {
    agentUserId: id('sender'),
    displayName: null,
    cachedAt: Date.now(),
  });
  await expectNoWrites(
    () =>
      invoke({ username, content: 'Not connected' }, undefined, disconnected),
    /active connection/
  );
  await expectNoWrites(
    () =>
      invoke(
        { content: 'Missing explicit destination' },
        { username, content: 'Valid stale state' }
      ),
    /exactly one destination/
  );
});
test('unknown, foreign and inactive provided chats deny delivery without writes', async () => {
  for (const chatId of [
    await generateSnowflakeId(),
    id('foreignChat'),
    id('inactiveChat'),
  ]) {
    await expectNoWrites(
      () =>
        invoke({ chatId, content: 'No unauthorized provided chat delivery' }),
      /not a member/
    );
  }
});
test('the actual A2A HTTP boundary refuses missing and invalid stored keys', async () => {
  const before = await messagingSnapshot();
  for (const key of ['', generateApiKey()]) {
    const response = await fetch(new URL('/api/a2a', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-feed-api-key': key },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'user',
            parts: [
              {
                kind: 'data',
                data: { operation: 'portfolio.get_balance', params: {} },
              },
            ],
          },
        },
      }),
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  expect(await messagingSnapshot()).toEqual(before);
});

afterAll(async () => {
  // One transaction: an unexpected tuple/reference retains the entire dataset.
  await db.transaction(async (tx) => {
    for (const table of [
      'Message',
      'DMAcceptance',
      'ChatParticipant',
      'Chat',
      'UserApiKey',
      'User',
    ] as const) {
      for (const row of owned[table].values()) {
        const name = sql.identifier(table);
        const same =
          table === 'UserApiKey'
            ? sql`(to_jsonb(t) - 'lastUsedAt') = (${row.canonical}::text::jsonb - 'lastUsedAt') AND (t."lastUsedAt" IS NULL OR t."lastUsedAt" BETWEEN ${firstUse}::timestamptz AND clock_timestamp())`
            : sql`to_jsonb(t) = ${row.canonical}::text::jsonb`;
        const references =
          table === 'Message'
            ? sql`
          NOT EXISTS (SELECT 1 FROM "MessageReaction" r WHERE r."messageId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."replyToMessageId" = t.id)
        `
            : table === 'Chat'
              ? sql`
          NOT EXISTS (SELECT 1 FROM "ChatParticipant" p WHERE p."chatId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "DMAcceptance" a WHERE a."chatId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."chatId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "MessageReaction" r WHERE r."chatId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."chatId" = t.id)
        `
              : table === 'User'
                ? sql`
          NOT EXISTS (SELECT 1 FROM "GameOnboarding" x WHERE x."userId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Whitelist" x WHERE x."userId" = t.id OR x."grantedBy" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "ChatParticipant" x WHERE x."userId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Message" x WHERE x."senderId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "DMAcceptance" x WHERE x."userId" = t.id OR x."otherUserId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "UserApiKey" x WHERE x."userId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "Follow" x WHERE x."followerId" = t.id OR x."followingId" = t.id)
          AND NOT EXISTS (SELECT 1 FROM "UserBlock" x WHERE x."blockerId" = t.id OR x."blockedId" = t.id)
        `
                : sql`true`;
        const deleted = await tx.execute<{ id: string }>(
          sql`DELETE FROM ${name} t WHERE t.id = ${row.id} AND ${same} AND ${references} RETURNING t.id`
        );
        assert.equal(
          deleted.length,
          1,
          `Physical ownership/reference refusal: ${table}`
        );
      }
    }
  });
  for (const table of Object.keys(owned) as Table[]) owned[table].clear();
});
