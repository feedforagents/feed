/**
 * F163 investigation: GET /api/groups/[groupId]/messages against a real
 * database — the group page's message list.
 *
 * Primary axis: cursor pagination walks by createdAt only
 * (`createdAt < cursor.createdAt`, order by createdAt desc, no id
 * tie-break). Messages that share the cursor message's timestamp fall
 * behind the strict inequality and are never returned by any later page.
 * The sibling chat history route (GET /api/chats/[id]) walks the same
 * list with a (createdAt, id) tuple cursor for exactly this reason.
 *
 * Secondary axes are recorded as observed behavior in the same fixture:
 * messages from an ex-member, from test-shaped authors (test- id prefix
 * and isTest flag), and from senders the viewer has blocked / muted /
 * been blocked by.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chats,
  db,
  groupMembers,
  groups,
  inArray,
  messages,
  sql,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type MessagesResponse = {
  success: boolean;
  messages: Array<{ id: string; sender: { id: string } }>;
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
};

let GET: typeof import('../../../apps/web/src/app/api/groups/[groupId]/messages/route').GET;

const runId = Math.floor(Math.random() * 1e9).toString();
const ids = {
  viewer: '',
  owner: '',
  senderA: '',
  exMember: '',
  testPrefix: '',
  isTestUser: '',
  blockedSender: '',
  mutedSender: '',
  blockerSender: '',
  outsider: '',
  groupP: '',
  chatP: '',
  groupM: '',
  chatM: '',
  groupU: '',
  chatU: '',
};
const ownedUsers: string[] = [];
const ownedGroups: string[] = [];
const ownedChats: string[] = [];
const ownedMessages: string[] = [];

const paginationMessageIds: string[] = [];
const microMessageIds: string[] = [];
const axisMessageBySender = new Map<string, string>();

async function snowflake() {
  return generateSnowflakeId();
}

async function makeUser(
  key: keyof typeof ids,
  opts: { isTest?: boolean; testPrefix?: boolean } = {}
) {
  const base = await snowflake();
  const id = opts.testPrefix ? `test-${base}` : base;
  ids[key] = id;
  ownedUsers.push(id);
  await db.insert(users).values({
    id,
    username: `f163_${key}_${runId}`,
    displayName: `F163 ${key}`,
    isTest: opts.isTest ?? false,
    updatedAt: new Date(),
  });
}

async function makeGroupChat(
  groupKey: 'groupP' | 'groupM' | 'groupU',
  chatKey: 'chatP' | 'chatM' | 'chatU',
  members: Array<{ userId: string; role?: string; isActive?: boolean }>
) {
  const now = new Date();
  const groupId = await snowflake();
  const chatId = await snowflake();
  ids[groupKey] = groupId;
  ids[chatKey] = chatId;
  ownedGroups.push(groupId);
  ownedChats.push(chatId);
  await db.insert(groups).values({
    id: groupId,
    name: `f163 ${groupKey} ${runId}`,
    type: 'user',
    ownerId: ids.owner,
    createdById: ids.owner,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: chatId,
    name: `f163 ${chatKey} ${runId}`,
    isGroup: true,
    groupId,
    createdAt: now,
    updatedAt: now,
  });
  for (const m of members) {
    await db.insert(groupMembers).values({
      id: await snowflake(),
      groupId,
      userId: m.userId,
      role: m.role ?? 'member',
      isActive: m.isActive ?? true,
      joinedAt: now,
    });
  }
}

async function addMessage(
  chatId: string,
  senderId: string,
  content: string,
  createdAt: Date
) {
  const id = await snowflake();
  ownedMessages.push(id);
  await db.insert(messages).values({
    id,
    chatId,
    senderId,
    content,
    type: 'user',
    createdAt,
  });
  return id;
}

async function fetchMessages(
  viewerId: string,
  groupId: string,
  params: { cursor?: string; limit?: number } = {}
) {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const url = `http://localhost/api/groups/${groupId}/messages${qs.toString() ? `?${qs.toString()}` : ''}`;
  const request = new NextRequest(
    new Request(url, {
      headers: {
        authorization: `Bearer ${['steward', 'test', viewerId].join(':')}`,
      },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ groupId }),
  });
  const body = (await response.json().catch(() => null)) as
    | MessagesResponse
    | { error?: unknown }
    | null;
  if (response.status >= 400) {
    console.log(
      `[f163] fetchMessages ${response.status} body=${JSON.stringify(body)?.slice(0, 300)}`
    );
  }
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/groups/[groupId]/messages/route'
  ));

  await makeUser('viewer');
  await makeUser('owner');
  await makeUser('senderA');
  await makeUser('exMember');
  await makeUser('testPrefix', { testPrefix: true });
  await makeUser('isTestUser', { isTest: true });
  await makeUser('blockedSender');
  await makeUser('mutedSender');
  await makeUser('blockerSender');
  await makeUser('outsider');

  // Chat P: pagination ties. Six messages, three sharing one timestamp.
  await makeGroupChat('groupP', 'chatP', [
    { userId: ids.owner, role: 'owner' },
    { userId: ids.viewer },
    { userId: ids.senderA },
  ]);
  const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h, 0, 0, 0));
  paginationMessageIds.push(
    await addMessage(ids.chatP, ids.senderA, 'p1 oldest', t(10)),
    await addMessage(ids.chatP, ids.senderA, 'p2', t(11)),
    await addMessage(ids.chatP, ids.senderA, 'p3 tie-a', t(12)),
    await addMessage(ids.chatP, ids.senderA, 'p4 tie-b', t(12)),
    await addMessage(ids.chatP, ids.senderA, 'p5 tie-c', t(12)),
    await addMessage(ids.chatP, ids.senderA, 'p6 newest', t(13))
  );

  // Chat M: membership / moderation / test-author axes, one message each.
  await makeGroupChat('groupM', 'chatM', [
    { userId: ids.owner, role: 'owner' },
    { userId: ids.viewer },
    { userId: ids.senderA },
    { userId: ids.exMember, isActive: false },
    { userId: ids.testPrefix },
    { userId: ids.isTestUser },
    { userId: ids.blockedSender },
    { userId: ids.mutedSender },
    { userId: ids.blockerSender },
  ]);
  const base = Date.UTC(2026, 0, 2, 10, 0, 0, 0);
  const axisSenders: Array<[string, string]> = [
    ['senderA', ids.senderA],
    ['exMember', ids.exMember],
    ['testPrefix', ids.testPrefix],
    ['isTestUser', ids.isTestUser],
    ['blockedSender', ids.blockedSender],
    ['mutedSender', ids.mutedSender],
    ['blockerSender', ids.blockerSender],
  ];
  let i = 0;
  for (const [label, senderId] of axisSenders) {
    const mid = await addMessage(
      ids.chatM,
      senderId,
      `axis ${label}`,
      new Date(base + i * 60_000)
    );
    axisMessageBySender.set(label, mid);
    i++;
  }

  // Chat U: microsecond cluster. Three messages inside one millisecond,
  // inserted with raw SQL because JS Dates cannot express µs precision —
  // this is the shape rows take when createdAt comes from the database
  // default (now()). A Date-based cursor comparison truncates all three
  // to the same millisecond.
  await makeGroupChat('groupU', 'chatU', [
    { userId: ids.owner, role: 'owner' },
    { userId: ids.viewer },
    { userId: ids.senderA },
  ]);
  for (const micros of ['500100', '500200', '500300']) {
    const mid = await snowflake();
    microMessageIds.push(mid);
    ownedMessages.push(mid);
    await db.execute(
      sql`INSERT INTO "Message" ("id", "chatId", "senderId", "content", "type", "createdAt") VALUES (${mid}, ${ids.chatU}, ${ids.senderA}, ${`micro ${micros}`}, 'user', ${`2026-01-03 10:00:00.${micros}`}::timestamp)`
    );
  }

  // Viewer moderation state: blocks blockedSender, mutes mutedSender,
  // and is blocked by blockerSender.
  await db.insert(userBlocks).values([
    {
      id: await snowflake(),
      blockerId: ids.viewer,
      blockedId: ids.blockedSender,
    },
    {
      id: await snowflake(),
      blockerId: ids.blockerSender,
      blockedId: ids.viewer,
    },
  ]);
  await db.insert(userMutes).values({
    id: await snowflake(),
    muterId: ids.viewer,
    mutedId: ids.mutedSender,
  });
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.id, ownedMessages));
  await db
    .delete(groupMembers)
    .where(inArray(groupMembers.groupId, ownedGroups));
  await db.delete(chats).where(inArray(chats.id, ownedChats));
  await db.delete(groups).where(inArray(groups.id, ownedGroups));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, ownedUsers));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, ownedUsers));
  await db.delete(userMutes).where(inArray(userMutes.muterId, ownedUsers));
  await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('GET /api/groups/[groupId]/messages (F163)', () => {
  it('walks every message across pages even when timestamps tie', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { status, body } = await fetchMessages(ids.viewer, ids.groupP, {
        cursor,
        limit: 2,
      });
      expect(status).toBe(200);
      const pageBody = body as MessagesResponse;
      for (const m of pageBody.messages) seen.push(m.id);
      if (!pageBody.pagination.hasMore) break;
      cursor = pageBody.pagination.nextCursor ?? undefined;
      expect(cursor).toBeTruthy();
    }
    console.log(
      `[f163] pagination walk: saw ${seen.length} of ${paginationMessageIds.length}; missing=${paginationMessageIds.filter((id) => !seen.includes(id)).join(',')}`
    );
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen.sort()).toEqual([...paginationMessageIds].sort());
  });

  it('walks every message across pages inside a microsecond cluster', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { status, body } = await fetchMessages(ids.viewer, ids.groupU, {
        cursor,
        limit: 1,
      });
      expect(status).toBe(200);
      const pageBody = body as MessagesResponse;
      for (const m of pageBody.messages) seen.push(m.id);
      if (!pageBody.pagination.hasMore) break;
      cursor = pageBody.pagination.nextCursor ?? undefined;
      expect(cursor).toBeTruthy();
    }
    console.log(
      `[f163] microsecond walk: saw ${seen.length} of ${microMessageIds.length}; missing=${microMessageIds.filter((id) => !seen.includes(id)).join(',')}`
    );
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen.sort()).toEqual([...microMessageIds].sort());
  });

  it('records which senders the viewer sees in the axis chat', async () => {
    const { status, body } = await fetchMessages(ids.viewer, ids.groupM, {
      limit: 50,
    });
    expect(status).toBe(200);
    const pageBody = body as MessagesResponse;
    const seenSenders = new Set(pageBody.messages.map((m) => m.sender.id));
    const report: Record<string, boolean> = {};
    for (const [label, senderId] of [
      ['senderA', ids.senderA],
      ['exMember', ids.exMember],
      ['testPrefix', ids.testPrefix],
      ['isTestUser', ids.isTestUser],
      ['blockedSender', ids.blockedSender],
      ['mutedSender', ids.mutedSender],
      ['blockerSender', ids.blockerSender],
    ] as Array<[string, string]>) {
      report[label] = seenSenders.has(senderId);
    }
    console.log(`[f163] axis visibility: ${JSON.stringify(report)}`);
    // Fact-finding only: the normal member's message must be visible.
    expect(report.senderA).toBe(true);
  });

  it('rejects a non-member viewer', async () => {
    const { status } = await fetchMessages(ids.outsider, ids.groupP, {});
    expect(status).toBe(403);
  });

  it('rejects an ex-member viewer (inactive membership)', async () => {
    const { status } = await fetchMessages(ids.exMember, ids.groupM, {});
    expect(status).toBe(403);
  });
});
