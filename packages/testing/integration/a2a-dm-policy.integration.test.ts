/** Retained social messaging policy. PRD §§8.2/12, MVP Phases 3/5. */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  recipientBlocked: 'refuses a DM when the recipient blocked the sender',
  senderBlocked: 'refuses a DM when the sender blocked the recipient',
  actorRecipient: 'refuses a DM to an NPC',
  allowed: 'saves permitted DMs and group messages',
  access: 'retains the authenticated membership requirement',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks A2A message policy in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'a2a-dm-policy',
      file: 'packages/testing/integration/a2a-dm-policy.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    chatParticipants,
    chats,
    db,
    eq,
    messages,
    userApiKeys,
    userBlocks,
    users,
  } = await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST } = await import('../../../apps/web/src/app/api/a2a/route');

  const sender = 'dm-policy-sender';
  const recipientBlocked = 'dm-policy-recipient-blocked';
  const senderBlocked = 'dm-policy-sender-blocked';
  const npc = 'dm-policy-npc';
  const allowed = 'dm-policy-allowed';
  const group = 'dm-policy-group';
  const inactive = 'dm-policy-inactive';
  const missing = 'dm-policy-missing';
  const content = 'A2A messaging policy fixture';
  const key = generateApiKey();
  const now = new Date();
  const members = [
    { id: recipientBlocked, users: [sender, recipientBlocked] },
    { id: senderBlocked, users: [sender, senderBlocked] },
    { id: npc, users: [sender, npc] },
    { id: allowed, users: [sender, allowed] },
    { id: group, users: [sender, npc, recipientBlocked] },
    { id: inactive, users: [sender, allowed] },
  ];

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [sender, recipientBlocked, senderBlocked, npc, allowed].map((id) => ({
        id,
        username: id,
        updatedAt: now,
        isActor: id === npc,
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'dm-policy-key',
      userId: sender,
      keyHash: hashApiKey(key),
    });
    await tx
      .insert(chats)
      .values(
        members.map(({ id }) => ({ id, isGroup: id === group, updatedAt: now }))
      );
    await tx.insert(chatParticipants).values(
      members.flatMap(({ id: chatId, users: userIds }) =>
        userIds.map((userId) => ({
          id: `${chatId}:${userId}`,
          chatId,
          userId,
          isActive: chatId !== inactive || userId !== sender,
        }))
      )
    );
    await tx.insert(userBlocks).values([
      { id: recipientBlocked, blockerId: recipientBlocked, blockedId: sender },
      { id: senderBlocked, blockerId: sender, blockedId: senderBlocked },
    ]);
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/a2a') {
        return new Response(null, { status: 404 });
      }
      // Exercise user-key authentication instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'dm-policy.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));

  const endpoint = new URL('/api/a2a', server.url);

  async function send(chatId: string) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: chatId,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: crypto.randomUUID(),
            parts: [
              {
                kind: 'data',
                data: {
                  operation: 'messaging.send_message',
                  params: { chatId, content },
                },
              },
            ],
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  for (const [chatId, name, refusal] of [
    [
      recipientBlocked,
      cases.recipientBlocked,
      'Cannot send messages to this user',
    ],
    [senderBlocked, cases.senderBlocked, 'Cannot send messages to this user'],
    [npc, cases.actorRecipient, 'Cannot send direct messages to NPC actors'],
  ] as const) {
    test(name, async () => {
      expect(await send(chatId)).toContain(refusal);
      expect(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.chatId, chatId))
      ).toEqual([]);
    });
  }

  test(cases.allowed, async () => {
    for (const chatId of [allowed, group]) {
      const response = JSON.parse(await send(chatId)) as {
        result?: { status?: { state?: string } };
      };
      expect(response.result?.status?.state).toBe('completed');
      expect(
        await db
          .select({ senderId: messages.senderId, content: messages.content })
          .from(messages)
          .where(eq(messages.chatId, chatId))
      ).toEqual([{ senderId: sender, content }]);
    }
  });

  test(cases.access, async () => {
    const unsigned = await fetch(endpoint, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    for (const chatId of [inactive, missing]) {
      expect(await send(chatId)).toContain('Chat not found or access denied');
      expect(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.chatId, chatId))
      ).toEqual([]);
    }
  });
}
