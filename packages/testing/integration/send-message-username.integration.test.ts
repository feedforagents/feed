/**
 * PRD §§8.2/12: exact recipient selection and authorized chat delivery.
 * Exercises the persisted username lookup and native messaging executor.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chatParticipants,
  chats,
  dbWrite as db,
  dmAcceptances,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';

import { executeDirectMessage } from '../../agents/src/autonomous/DirectExecutors';
import { resolveUserByUsername } from '../../agents/src/autonomous/utils/context-gatherers';

type Table = 'User' | 'Chat' | 'ChatParticipant' | 'DMAcceptance' | 'Message';
type Receipt = { id: string; canonical: string };
const owned: Record<Table, Map<string, Receipt>> = {
  User: new Map(),
  Chat: new Map(),
  ChatParticipant: new Map(),
  DMAcceptance: new Map(),
  Message: new Map(),
};
const ids = new Map<string, string>();
let username = '';
let ambiguous = '';

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
function assertDisposableDatabase(url: URL, ci: boolean) {
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  const port = url.port || '5432';
  assert.ok(
    (port === '55685' &&
      url.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(url.pathname)) ||
      (ci &&
        port === '5432' &&
        url.username === 'postgres' &&
        url.pathname === '/test_db'),
    'Disposable local fixture or documented CI database required'
  );
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  assertDisposableDatabase(url, process.env.CI === 'true');
  assert.equal(process.env.DIRECT_DATABASE_URL, process.env.DATABASE_URL);
  assert.ok(!process.env.DATABASE_READ_REPLICA_URL?.trim());
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
  const pending: typeof owned = {
    User: new Map(),
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
  });
  for (const table of Object.keys(owned) as Table[])
    acquire(owned, table, [...pending[table].values()]);
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
test('mixed-case handles and a leading @ select the correct DM recipient', async () => {
  for (const name of [
    username,
    username.toLowerCase(),
    username.toUpperCase(),
    `@${username}`,
  ]) {
    const recipientId = await resolveUserByUsername(name);
    assert.equal(recipientId, id('target'));
    const content = `Exact content for ${name}`;
    const result = await executeDirectMessage({
      agentUserId: id('sender'),
      recipientId,
      content,
    });
    assert.ok(result.success && result.messageId, result.error);
    const rows = await db.execute<
      Receipt & { senderId: string; chatId: string; content: string }
    >(sql`
      SELECT id, to_jsonb(m)::text AS canonical, "senderId", "chatId", content
      FROM "Message" m WHERE id = ${result.messageId}
    `);
    const row = rows[0];
    assert.ok(row && rows.length === 1);
    assert.equal(row.senderId, id('sender'));
    assert.equal(row.content, content);
    acquire(owned, 'Message', [row]);
    expect(row.chatId).toBe(id('correctChat'));
  }
});

test('ambiguous and unknown usernames do not select a recipient or create writes', async () => {
  const before = await messagingSnapshot();
  await expect(resolveUserByUsername(ambiguous)).rejects.toThrow(
    'Ambiguous username'
  );
  expect(await resolveUserByUsername(`missing_${id('sender')}`)).toBeNull();
  expect(await messagingSnapshot()).toEqual(before);
});

test('unknown, foreign and inactive chats reject native delivery without writes', async () => {
  const before = await messagingSnapshot();
  for (const chatId of [
    await generateSnowflakeId(),
    id('foreignChat'),
    id('inactiveChat'),
  ]) {
    expect(
      await executeDirectMessage({
        agentUserId: id('sender'),
        chatId,
        content: 'No unauthorized provided chat delivery',
      })
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('not a member'),
    });
    expect(await messagingSnapshot()).toEqual(before);
  }
});

afterAll(async () => {
  // One transaction: an unexpected tuple/reference retains the entire dataset.
  await db.transaction(async (tx) => {
    for (const table of [
      'Message',
      'DMAcceptance',
      'ChatParticipant',
      'Chat',
      'User',
    ] as const) {
      for (const row of owned[table].values()) {
        const name = sql.identifier(table);
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
          sql`DELETE FROM ${name} t WHERE t.id = ${row.id} AND to_jsonb(t) = ${row.canonical}::text::jsonb AND ${references} RETURNING t.id`
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
