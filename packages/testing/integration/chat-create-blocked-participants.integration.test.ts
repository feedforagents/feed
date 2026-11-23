/** PRD §12 and MVP Phase 5: apply viewer blocks at web chat creation. */
import { afterAll, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const blockedCase = 'rejects a DM to a user the creator blocked';
const blockingCase = 'rejects a DM to a user who blocked the creator';
const npcCase = 'rejects a DM to an NPC actor';
const mixedGroupCase =
  'excludes blocked users and keeps eligible group participants';
const groupControlCase = 'creates a group chat with an eligible participant';
const dmControlCase = 'creates a DM for an eligible participant';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks chat creation moderation in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'chat-create-moderation',
      file: 'packages/testing/integration/chat-create-blocked-participants.integration.test.ts',
      cases: [
        blockedCase,
        blockingCase,
        npcCase,
        mixedGroupCase,
        groupControlCase,
        dmControlCase,
      ],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  const { chatParticipants, chats, count, db, eq, userBlocks, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { z } = await import('zod');
  const { createStewardTestToken } = await import('./helpers/steward-auth');
  const { GET, POST } = await import(
    '../../../apps/web/src/app/api/chats/route'
  );

  async function fixtureUser(label: string, isActor = false) {
    const id = await generateSnowflakeId();
    const stewardId = `chat-${label}-${id}`;
    return {
      row: {
        id,
        username: `chat-moderation-${id}`,
        stewardId,
        isActor,
        updatedAt: new Date(),
      },
      token: await createStewardTestToken(stewardId),
    };
  }

  const [creator, blocked, blocker, ordinary, npc] = await Promise.all([
    fixtureUser('creator'),
    fixtureUser('blocked'),
    fixtureUser('blocker'),
    fixtureUser('ordinary'),
    fixtureUser('npc', true),
  ] as const);
  const [outgoingBlockId, incomingBlockId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ] as const);
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values([creator, blocked, blocker, ordinary, npc].map(({ row }) => row));
    await tx.insert(userBlocks).values([
      {
        id: outgoingBlockId,
        blockerId: creator.row.id,
        blockedId: blocked.row.id,
      },
      {
        id: incomingBlockId,
        blockerId: blocker.row.id,
        blockedId: creator.row.id,
      },
    ]);
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/chats')
        return new Response(null, { status: 404 });
      if (request.method === 'GET') return GET(new NextRequest(request));
      if (request.method === 'POST') return POST(new NextRequest(request));
      return new Response(null, { status: 405 });
    },
  });
  afterAll(async () => {
    await server.stop(true);
  });

  const chatsUrl = new URL('/api/chats', server.url);
  const createSchema = z.object({
    chat: z.object({ id: z.string() }).optional(),
    error: z.string().optional(),
  });
  const listSchema = z.object({
    directChats: z.array(z.object({ id: z.string() })),
  });

  async function createChat(participantIds: string[], name?: string) {
    const response = await fetch(chatsUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creator.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        isGroup: name !== undefined,
        name,
        participantIds,
      }),
    });
    return {
      status: response.status,
      body: createSchema.parse(await response.json()),
    };
  }

  async function visibleDirectChats(token: string) {
    const response = await fetch(chatsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return listSchema
      .parse(await response.json())
      .directChats.map(({ id }) => id);
  }

  async function expectRejected(
    target: Awaited<ReturnType<typeof fixtureUser>>,
    message: string
  ) {
    const before = await db.select({ total: count() }).from(chats);
    const result = await createChat([target.row.id]);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(message);
    expect(result.body.chat).toBeUndefined();
    expect(await db.select({ total: count() }).from(chats)).toEqual(before);
    if (!target.row.isActor) {
      expect(await visibleDirectChats(creator.token)).toEqual([]);
      expect(await visibleDirectChats(target.token)).toEqual([]);
    }
  }

  async function expectParticipants(
    participantIds: string[],
    expectedIds: string[],
    groupName?: string
  ) {
    const result = await createChat(participantIds, groupName);
    expect(result.status).toBe(201);
    const chatId = result.body.chat?.id;
    if (!chatId) throw new Error('The chat response omitted its ID');
    const participants = await db
      .select({ userId: chatParticipants.userId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    expect(participants.map(({ userId }) => userId).sort()).toEqual(
      [creator.row.id, ...expectedIds].sort()
    );
  }

  const blockedMessage = 'Cannot send messages to this user';
  test(blockedCase, () => expectRejected(blocked, blockedMessage));
  test(blockingCase, () => expectRejected(blocker, blockedMessage));
  test(npcCase, () =>
    expectRejected(
      npc,
      'Cannot send direct messages to NPC actors. Use group chats to interact with NPCs.'
    )
  );

  test(mixedGroupCase, () =>
    expectParticipants(
      [blocked.row.id, blocker.row.id, ordinary.row.id, npc.row.id],
      [ordinary.row.id, npc.row.id],
      'Mixed group'
    )
  );
  test(groupControlCase, () =>
    expectParticipants([ordinary.row.id], [ordinary.row.id], 'Eligible group')
  );
  test(dmControlCase, () =>
    expectParticipants([ordinary.row.id], [ordinary.row.id])
  );
}
