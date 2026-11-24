/** PRD §12 and MVP Phase 5: apply viewer blocks when adding chat participants. */
import { afterAll, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const blockedCase = 'refuses to add a user the adder blocked';
const blockingCase = 'refuses to add a user who blocked the adder';
const mixedCase = 'adds only the eligible user from a mixed list';
const controlCase = 'adds an eligible user';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks chat participant-add moderation in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'chat-add-participants-moderation',
      file: 'packages/testing/integration/chat-add-participants-blocked.integration.test.ts',
      cases: [blockedCase, blockingCase, mixedCase, controlCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  const { and, chatParticipants, chats, db, eq, userBlocks, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { z } = await import('zod');
  const { createStewardTestToken } = await import('./helpers/steward-auth');
  const { POST } = await import(
    '../../../apps/web/src/app/api/chats/[id]/participants/route'
  );

  async function fixtureUser(label: string) {
    const id = await generateSnowflakeId();
    const stewardId = `chat-add-${label}-${id}`;
    return {
      row: {
        id,
        username: `chat-add-moderation-${id}`,
        stewardId,
        updatedAt: new Date(),
      },
      token: await createStewardTestToken(stewardId),
    };
  }

  const [adder, blocked, blocker, ordinaryA, ordinaryB] = await Promise.all([
    fixtureUser('adder'),
    fixtureUser('blocked'),
    fixtureUser('blocker'),
    fixtureUser('ordinary-a'),
    fixtureUser('ordinary-b'),
  ] as const);
  const [outgoingBlockId, incomingBlockId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ] as const);
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values(
        [adder, blocked, blocker, ordinaryA, ordinaryB].map(({ row }) => row)
      );
    await tx.insert(userBlocks).values([
      {
        id: outgoingBlockId,
        blockerId: adder.row.id,
        blockedId: blocked.row.id,
      },
      {
        id: incomingBlockId,
        blockerId: blocker.row.id,
        blockedId: adder.row.id,
      },
    ]);
  });

  // One group chat per case so adds never leak across cases.
  const chatIds = await Promise.all(
    [0, 1, 2, 3].map(() => generateSnowflakeId())
  );
  const [chatBlockedOnly, chatBlockerOnly, chatMixed, chatControl] = chatIds;
  if (!chatBlockedOnly || !chatBlockerOnly || !chatMixed || !chatControl) {
    throw new Error('Fixture chats were not created');
  }
  const now = new Date();
  await db.insert(chats).values(
    chatIds.map((id) => ({
      id,
      name: `Participant moderation fixture ${id}`,
      isGroup: true,
      createdBy: adder.row.id,
      updatedAt: now,
    }))
  );
  await db.insert(chatParticipants).values(
    await Promise.all(
      chatIds.map(async (chatId) => ({
        id: await generateSnowflakeId(),
        chatId,
        userId: adder.row.id,
        isActive: true,
      }))
    )
  );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const match = /^\/api\/chats\/([^/]+)\/participants$/.exec(
        new URL(request.url).pathname
      );
      if (request.method === 'POST' && match?.[1]) {
        return POST(new NextRequest(request), {
          params: Promise.resolve({ id: match[1] }),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  afterAll(async () => {
    await server.stop(true);
  });

  const errorSchema = z.object({ error: z.string() });
  const addSchema = z.object({
    data: z.object({
      chatId: z.string(),
      addedUsers: z.array(z.object({ id: z.string() })),
    }),
  });

  async function addParticipants(chatId: string, userIds: string[]) {
    const response = await fetch(
      new URL(`/api/chats/${chatId}/participants`, server.url),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adder.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userIds }),
      }
    );
    return { status: response.status, body: await response.json() };
  }

  async function participantUserIds(chatId: string) {
    const rows = await db
      .select({ userId: chatParticipants.userId })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.isActive, true)
        )
      );
    return rows.map(({ userId }) => userId).sort();
  }

  async function expectRefused(
    chatId: string,
    target: Awaited<ReturnType<typeof fixtureUser>>
  ) {
    const before = await participantUserIds(chatId);
    const result = await addParticipants(chatId, [target.row.id]);
    expect(result.status).toBe(400);
    expect(errorSchema.parse(result.body).error).toBe('No valid users to add');
    expect(await participantUserIds(chatId)).toEqual(before);
  }

  test(blockedCase, () => expectRefused(chatBlockedOnly, blocked));
  test(blockingCase, () => expectRefused(chatBlockerOnly, blocker));

  test(mixedCase, async () => {
    const result = await addParticipants(chatMixed, [
      blocked.row.id,
      blocker.row.id,
      ordinaryA.row.id,
    ]);
    expect(result.status).toBe(200);
    expect(
      addSchema.parse(result.body).data.addedUsers.map(({ id }) => id)
    ).toEqual([ordinaryA.row.id]);
    expect(await participantUserIds(chatMixed)).toEqual(
      [adder.row.id, ordinaryA.row.id].sort()
    );
  });

  test(controlCase, async () => {
    const result = await addParticipants(chatControl, [ordinaryB.row.id]);
    expect(result.status).toBe(200);
    expect(
      addSchema.parse(result.body).data.addedUsers.map(({ id }) => id)
    ).toEqual([ordinaryB.row.id]);
    expect(await participantUserIds(chatControl)).toEqual(
      [adder.row.id, ordinaryB.row.id].sort()
    );
  });
}
