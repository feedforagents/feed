/**
 * Real A2A group creation skips unknown and banned requested members.
 * This tests eligibility, not parity with REST's human invitation policy.
 * Only successful INSERT RETURNING rows or the committed executor result
 * establish ownership. Cleanup compares complete stored tuples (including
 * timestamp microseconds) and refuses changed or externally referenced rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { dbWrite, sql } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

const tableNames = [
  'User',
  'Group',
  'Chat',
  'GroupMember',
  'ChatParticipant',
  'GameOnboarding',
  'UserPnLSnapshot',
  'Whitelist',
  'WhitelistConfig',
] as const;
type TableName = (typeof tableNames)[number];
type StoredRow = { id: string; snapshot: string };
type InsertValue = string | boolean | number | null;
function ownership() {
  return new Map<TableName, Map<string, StoredRow>>(
    tableNames.map((table) => [table, new Map<string, StoredRow>()])
  );
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
const resultSchema = z.object({
  success: z.boolean(),
  group: z.object({ id: z.string(), name: z.string(), chatId: z.string() }),
});
let creatorId: string;
let validMemberId: string;
let bannedMemberId: string;
let ghostMemberId: string;

async function insertRow(
  table: TableName,
  values: Record<string, InsertValue>,
  receipt: Ownership = owned
) {
  const entries = Object.entries(values);
  const rows = await dbWrite.execute<StoredRow>(sql`
    INSERT INTO ${sql.identifier(table)}
      (${sql.join(
        entries.map(([key]) => sql.identifier(key)),
        sql`, `
      )})
    VALUES (${sql.join(
      entries.map(([, value]) => sql`${value}`),
      sql`, `
    )})
    RETURNING id, to_jsonb(${sql.identifier(table)})::text AS snapshot
  `);
  for (const row of rows) receipt.get(table)!.set(row.id, row);
  if (rows.length !== 1) throw new Error('Incomplete fixture RETURNING');
  return rows[0]!;
}

async function readRow(table: TableName, id: string) {
  return dbWrite.execute<StoredRow>(sql`
    SELECT id, to_jsonb(t)::text AS snapshot
    FROM ${sql.identifier(table)} AS t WHERE id = ${id}
  `);
}

function deletionGuard(table: TableName, id: string) {
  switch (table) {
    case 'Group':
      return sql`
        NOT EXISTS (SELECT 1 FROM "GroupMember" WHERE "groupId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Chat" WHERE "groupId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "GroupInvite" WHERE "groupId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Group" WHERE "parentGroupId" = ${id})`;
    case 'Chat':
      return sql`
        NOT EXISTS (SELECT 1 FROM "ChatParticipant" WHERE "chatId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Message" WHERE "chatId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "MessageReaction" WHERE "chatId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "DMAcceptance" WHERE "chatId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Group" WHERE "activeChatId" = ${id})`;
    case 'User':
      return sql`
        NOT EXISTS (SELECT 1 FROM "GameOnboarding" WHERE "userId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "UserPnLSnapshot" WHERE "userId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Whitelist" WHERE "userId" = ${id} OR "grantedBy" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Group" WHERE "ownerId" = ${id} OR "createdById" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "GroupMember" WHERE "userId" = ${id} OR "addedBy" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "ChatParticipant" WHERE "userId" = ${id} OR "invitedBy" = ${id} OR "addedBy" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Chat" WHERE "createdBy" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "Message" WHERE "senderId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "MessageReaction" WHERE "userId" = ${id}) AND
        NOT EXISTS (SELECT 1 FROM "GroupInvite" WHERE "invitedUserId" = ${id} OR "invitedBy" = ${id})`;
    default:
      return sql`true`;
  }
}

async function cleanup(receipt: Ownership = owned) {
  const failures: Error[] = [];
  // Failed receipts remain available for inspection and a later safe retry.
  for (const table of [
    'GroupMember',
    'ChatParticipant',
    'Chat',
    'Group',
    'GameOnboarding',
    'UserPnLSnapshot',
    'Whitelist',
    'WhitelistConfig',
    'User',
  ] as const) {
    for (const row of [...receipt.get(table)!.values()]) {
      try {
        await dbWrite.execute(sql`
          DELETE FROM ${sql.identifier(table)} AS t
          WHERE id = ${row.id} AND to_jsonb(t) = ${row.snapshot}::jsonb
            AND (${deletionGuard(table, row.id)})
        `);
        if ((await readRow(table, row.id)).length)
          throw new Error(`Owned fixture row retained: ${table}/${row.id}`);
        receipt.get(table)!.delete(row.id);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned group fixture cleanup incomplete'
    );
}

async function createGroup(memberIds: string[], name: string) {
  const result = resultSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'messaging.create_group',
      { name, memberIds },
      creatorId
    )
  );
  // The operation committed these generated IDs. Capture them before any test
  // assertion. An exception before a result never authorizes a guessed delete.
  const groups = await dbWrite.execute<
    StoredRow & {
      ownerId: string;
      createdById: string;
      name: string;
      createdAt: string;
    }
  >(sql`
    SELECT id, to_jsonb(g)::text AS snapshot, "ownerId", "createdById", name,
      "createdAt"::text AS "createdAt" FROM "Group" g WHERE id = ${result.group.id}
  `);
  const group = groups[0];
  if (
    !group ||
    group.ownerId !== creatorId ||
    group.createdById !== creatorId ||
    group.name !== name
  )
    throw new Error('Executor group provenance mismatch');
  owned.get('Group')!.set(group.id, { id: group.id, snapshot: group.snapshot });
  const chats = await dbWrite.execute<
    StoredRow & {
      groupId: string;
      name: string;
      isGroup: boolean;
      createdAt: string;
    }
  >(sql`
    SELECT id, to_jsonb(c)::text AS snapshot, "groupId", name, "isGroup",
      "createdAt"::text AS "createdAt" FROM "Chat" c WHERE id = ${result.group.chatId}
  `);
  const chat = chats[0];
  if (
    !chat ||
    chat.groupId !== group.id ||
    chat.name !== name ||
    !chat.isGroup ||
    chat.createdAt !== group.createdAt
  )
    throw new Error('Executor chat provenance mismatch');
  owned.get('Chat')!.set(chat.id, { id: chat.id, snapshot: chat.snapshot });
  const allowed = new Set([creatorId, ...memberIds]);
  for (const [table, column, parentId] of [
    ['GroupMember', 'groupId', group.id],
    ['ChatParticipant', 'chatId', chat.id],
  ] as const) {
    const children = await dbWrite.execute<
      StoredRow & { userId: string; joinedAt: string; isActive: boolean }
    >(sql`
      SELECT id, to_jsonb(t)::text AS snapshot, "userId", "joinedAt"::text AS "joinedAt", "isActive"
      FROM ${sql.identifier(table)} t WHERE ${sql.identifier(column)} = ${parentId}
    `);
    if (
      children.some(
        (row) =>
          !allowed.has(row.userId) ||
          row.joinedAt !== group.createdAt ||
          !row.isActive
      ) ||
      new Set(children.map((row) => row.userId)).size !== children.length ||
      !children.some((row) => row.userId === creatorId)
    )
      throw new Error('Executor membership provenance mismatch');
    for (const row of children)
      owned.get(table)!.set(row.id, { id: row.id, snapshot: row.snapshot });
  }
  return result;
}

async function memberUserIds(groupId: string): Promise<string[]> {
  const rows = await dbWrite.execute<{ userId: string }>(sql`
    SELECT "userId" FROM "GroupMember" WHERE "groupId" = ${groupId}
  `);
  return rows.map((row) => row.userId);
}
async function participantUserIds(chatId: string): Promise<string[]> {
  const rows = await dbWrite.execute<{ userId: string }>(sql`
    SELECT "userId" FROM "ChatParticipant" WHERE "chatId" = ${chatId}
  `);
  return rows.map((row) => row.userId);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/(test_db|feed_pr\d+)$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    !['5432', '5433', '55685'].includes(url.port) ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== url.href) ||
    process.env.DATABASE_READ_REPLICA_URL
  )
    throw new Error(
      'Group fixture requires an isolated local disposable primary database'
    );
  [creatorId, validMemberId, bannedMemberId, ghostMemberId] =
    (await Promise.all(
      Array.from({ length: 4 }, () => generateSnowflakeId())
    )) as [string, string, string, string];
  for (const [id, label, banned] of [
    [creatorId, 'creator', false],
    [validMemberId, 'valid', false],
    [bannedMemberId, 'banned', true],
  ] as const) {
    await insertRow('User', {
      id,
      username: `cg-${label}-${id}`,
      isBanned: banned,
      updatedAt: new Date().toISOString(),
    });
  }
});
afterAll(async () => cleanup());

describe('A2A messaging.create_group member validation', () => {
  it('adds only existing, non-banned members', async () => {
    const result = await createGroup(
      [validMemberId, ghostMemberId, bannedMemberId],
      'Group with invalid members'
    );
    expect(result.success).toBe(true);

    const members = await memberUserIds(result.group.id);
    expect(members).toContain(creatorId);
    expect(members).toContain(validMemberId);
    expect(members).not.toContain(ghostMemberId);
    expect(members).not.toContain(bannedMemberId);

    const participants = await participantUserIds(result.group.chatId);
    expect(participants).toContain(creatorId);
    expect(participants).toContain(validMemberId);
    expect(participants).not.toContain(ghostMemberId);
    expect(participants).not.toContain(bannedMemberId);
  });

  it('adds a valid member as a control', async () => {
    const result = await createGroup(
      [validMemberId],
      'Group with one valid member'
    );
    expect(result.success).toBe(true);

    const members = await memberUserIds(result.group.id);
    expect(members).toContain(creatorId);
    expect(members).toContain(validMemberId);
  });
});

async function seedGraph(receipt: Ownership) {
  const [userId, groupId, chatId, memberId, participantId] = (await Promise.all(
    Array.from({ length: 5 }, () => generateSnowflakeId())
  )) as [string, string, string, string, string];
  const now = new Date().toISOString();
  await insertRow(
    'User',
    { id: userId, username: `cg-control-${userId}`, updatedAt: now },
    receipt
  );
  await insertRow(
    'Group',
    {
      id: groupId,
      name: 'Ownership control',
      type: 'user',
      ownerId: userId,
      createdById: userId,
      updatedAt: now,
    },
    receipt
  );
  await insertRow(
    'Chat',
    {
      id: chatId,
      name: 'Ownership control',
      isGroup: true,
      groupId,
      updatedAt: now,
    },
    receipt
  );
  await insertRow(
    'GroupMember',
    { id: memberId, groupId, userId, role: 'admin' },
    receipt
  );
  await insertRow(
    'ChatParticipant',
    { id: participantId, chatId, userId },
    receipt
  );
  return { userId, groupId, chatId };
}

async function expectUnchanged(receipt: Ownership) {
  for (const [table, rows] of receipt) {
    for (const row of rows.values())
      expect([...(await readRow(table, row.id))]).toEqual([row]);
  }
}

async function collision(table: TableName, row: StoredRow, receipt: Ownership) {
  let duplicate = false;
  try {
    const rows = await dbWrite.execute<StoredRow>(sql`
      INSERT INTO ${sql.identifier(table)}
      SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(table)}, ${row.snapshot}::jsonb)
      RETURNING id, to_jsonb(${sql.identifier(table)})::text AS snapshot
    `);
    for (const inserted of rows) receipt.get(table)!.set(inserted.id, inserted);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const cause = error.cause instanceof Error ? error.cause : error;
    if (!('code' in cause) || cause.code !== '23505') throw error;
    duplicate = true;
  }
  expect(duplicate).toBe(true);
}

describe('Group fixture ownership controls', () => {
  it('keeps duplicate/self membership unique and preserves existing input refusal', async () => {
    const result = await createGroup(
      [creatorId, validMemberId, validMemberId],
      'Deduplicated group'
    );
    expect((await memberUserIds(result.group.id)).sort()).toEqual(
      [creatorId, validMemberId].sort()
    );
    expect((await participantUserIds(result.group.chatId)).sort()).toEqual(
      [creatorId, validMemberId].sort()
    );
    await expect(
      FeedAgentExecutor.executeDirectly(
        'messaging.create_group',
        { name: 'Invalid members', memberIds: [''] },
        creatorId
      )
    ).rejects.toThrow('memberIds must be an explicit array of nonempty IDs');
    await expect(
      FeedAgentExecutor.executeDirectly(
        'messaging.create_group',
        { name: ' ', memberIds: [] },
        creatorId
      )
    ).rejects.toThrow('Group name is required');
  });

  it('acquires no collided rows and cleans partial setup without changing foreign full tuples', async () => {
    const foreign = ownership(),
      partial = ownership();
    try {
      const { userId } = await seedGraph(foreign);
      const now = new Date().toISOString();
      await insertRow(
        'GameOnboarding',
        { id: await generateSnowflakeId(), userId },
        foreign
      );
      await insertRow(
        'UserPnLSnapshot',
        { id: await generateSnowflakeId(), userId, snapshotAt: now },
        foreign
      );
      await insertRow(
        'Whitelist',
        {
          id: await generateSnowflakeId(),
          userId,
          grantedBy: userId,
          source: 'admin_manual',
        },
        foreign
      );
      await insertRow(
        'WhitelistConfig',
        { id: await generateSnowflakeId(), updatedBy: userId },
        foreign
      );
      await seedGraph(partial);
      for (const [table, rows] of foreign) {
        const attempted = ownership();
        for (const row of rows.values()) await collision(table, row, attempted);
        expect(attempted.get(table)!.size).toBe(0);
        await cleanup(attempted);
      }
      await cleanup(partial);
      expect([...partial.values()].every((rows) => rows.size === 0)).toBe(true);
      await expectUnchanged(foreign);
    } finally {
      await cleanup(partial);
      await cleanup(foreign);
    }
  });

  it('refuses foreign group/chat children and changed owned tuples', async () => {
    const subject = ownership(),
      foreign = ownership();
    try {
      const graph = await seedGraph(subject);
      const foreignUser = await generateSnowflakeId();
      await insertRow(
        'User',
        {
          id: foreignUser,
          username: `cg-foreign-${foreignUser}`,
          updatedAt: new Date().toISOString(),
        },
        foreign
      );
      await insertRow(
        'GroupMember',
        {
          id: await generateSnowflakeId(),
          groupId: graph.groupId,
          userId: foreignUser,
        },
        foreign
      );
      await insertRow(
        'ChatParticipant',
        {
          id: await generateSnowflakeId(),
          chatId: graph.chatId,
          userId: foreignUser,
        },
        foreign
      );
      await expect(cleanup(subject)).rejects.toThrow(
        'Owned group fixture cleanup incomplete'
      );
      expect(subject.get('Group')!.size).toBe(1);
      expect(subject.get('Chat')!.size).toBe(1);
      await expectUnchanged(subject);
      await expectUnchanged(foreign);
      await cleanup(foreign);
      const original = subject.get('User')!.get(graph.userId)!;
      await dbWrite.execute(
        sql`UPDATE "User" SET username = ${`cg-changed-${graph.userId}`} WHERE id = ${graph.userId}`
      );
      const changed = [...(await readRow('User', graph.userId))];
      await expect(cleanup(subject)).rejects.toThrow(
        'Owned group fixture cleanup incomplete'
      );
      expect(subject.get('User')!.get(graph.userId)).toEqual(original);
      expect([...(await readRow('User', graph.userId))]).toEqual(changed);
      await dbWrite.execute(
        sql`UPDATE "User" SET username = (${original.snapshot}::jsonb ->> 'username') WHERE id = ${graph.userId}`
      );
    } finally {
      await cleanup(foreign);
      await cleanup(subject);
    }
  });

  it('refuses all five destructive User FK paths without deleting or nulling foreign controls', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    const ids: string[] = [];
    try {
      for (const receipt of subjects) {
        const id = await generateSnowflakeId();
        ids.push(id);
        await insertRow(
          'User',
          { id, username: `cg-fk-${id}`, updatedAt: new Date().toISOString() },
          receipt
        );
      }
      await insertRow(
        'GameOnboarding',
        { id: await generateSnowflakeId(), userId: ids[0]! },
        foreign
      );
      await insertRow(
        'UserPnLSnapshot',
        {
          id: await generateSnowflakeId(),
          userId: ids[1]!,
          snapshotAt: new Date().toISOString(),
        },
        foreign
      );
      await insertRow(
        'Whitelist',
        {
          id: await generateSnowflakeId(),
          userId: ids[2]!,
          grantedBy: ids[3]!,
          source: 'admin_manual',
        },
        foreign
      );
      await insertRow(
        'WhitelistConfig',
        { id: await generateSnowflakeId(), updatedBy: ids[4]! },
        foreign
      );
      for (const receipt of subjects) {
        await expect(cleanup(receipt)).rejects.toThrow(
          'Owned group fixture cleanup incomplete'
        );
        expect(receipt.get('User')!.size).toBe(1);
        await expectUnchanged(receipt);
        await expectUnchanged(foreign);
      }
    } finally {
      await cleanup(foreign);
      for (const receipt of subjects) await cleanup(receipt);
    }
  });
});
