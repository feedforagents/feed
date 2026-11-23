/** Retained group message pagination. PRD §§9.5/12, MVP Phase 5. */
import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  tied: 'walks every message across pages even when timestamps tie',
  microseconds: 'walks every message across pages inside a microsecond cluster',
  visibility: 'records which senders the viewer sees in the axis chat',
  outsider: 'rejects a non-member viewer',
  inactive: 'rejects an ex-member viewer (inactive membership)',
};
const suite = 'GET /api/groups/[groupId]/messages (F163)';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks group pagination in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'group-messages-pagination',
      file: 'packages/testing/integration/group-messages-pagination.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'false';

  const {
    chats,
    db,
    groupMembers,
    groups,
    messages,
    sql,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET } = await import(
    '../../../apps/web/src/app/api/groups/[groupId]/messages/route'
  );

  type MessagesResponse = {
    success: boolean;
    messages: Array<{ id: string; sender: { id: string } }>;
    pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
  };

  const runId = crypto.randomUUID();
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

  const paginationMessageIds: string[] = [];
  const microMessageIds: string[] = [];

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
    await db.insert(users).values({
      id,
      username: `f163_${key}_${runId}`,
      stewardId: stewardSubject(id),
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

  function stewardSubject(viewerId: string) {
    return `pagination-fixture-${viewerId}`;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const [, groupId] =
        /^\/api\/groups\/([^/]+)\/messages$/.exec(
          new URL(request.url).pathname
        ) ?? [];
      if (request.method !== 'GET' || !groupId) {
        return new Response(null, { status: 404 });
      }
      return GET(new NextRequest(request), {
        params: Promise.resolve({ groupId }),
      });
    },
  });
  afterAll(() => server.stop(true));

  async function fetchMessages(
    viewerId: string | null,
    groupId: string,
    params: { cursor?: string; limit?: number } = {}
  ) {
    const url = new URL(`/api/groups/${groupId}/messages`, server.url);
    if (params.cursor) url.searchParams.set('cursor', params.cursor);
    if (params.limit) url.searchParams.set('limit', String(params.limit));
    const headers = new Headers();
    if (viewerId) {
      const token = await createStewardTestToken(stewardSubject(viewerId));
      headers.set('authorization', `Bearer ${token}`);
    }
    const response = await fetch(url, { headers });
    const body = (await response.json()) as
      | MessagesResponse
      | { error?: unknown };
    if (response.status >= 400) {
      console.log(
        `[f163] fetchMessages ${response.status} body=${JSON.stringify(body).slice(0, 300)}`
      );
    }
    return { status: response.status, body };
  }

  beforeAll(async () => {
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
      await addMessage(
        ids.chatM,
        senderId,
        `axis ${label}`,
        new Date(base + i * 60_000)
      );
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

  describe(suite, () => {
    it(cases.tied, async () => {
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
      expect(seen).toEqual([...paginationMessageIds].reverse());
    });

    it(cases.microseconds, async () => {
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
      expect(seen).toEqual([...microMessageIds].reverse());
    });

    it(cases.visibility, async () => {
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

    it(cases.outsider, async () => {
      const { status } = await fetchMessages(ids.outsider, ids.groupP, {});
      expect(status).toBe(403);
      expect((await fetchMessages(null, ids.groupP)).status).toBe(401);
      expect(
        (
          await fetchMessages(ids.viewer, ids.groupP, {
            cursor: microMessageIds[0],
          })
        ).status
      ).toBe(400);
    });

    it(cases.inactive, async () => {
      const { status } = await fetchMessages(ids.exMember, ids.groupM, {});
      expect(status).toBe(403);
    });
  });
}
