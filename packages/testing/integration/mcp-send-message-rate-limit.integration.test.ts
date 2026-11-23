/** Web and MCP chat messages share the per-account budget (PRD §8.1). */
import { afterAll, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  mcp: 'two MCP connections spend one account message budget',
  webToMcp: 'a web message counts against the same MCP message budget',
  mcpToWeb: 'MCP messages count against the same web message budget',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the shared message budget in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-send-message-rate-limit',
      file: 'packages/testing/integration/mcp-send-message-rate-limit.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // The general integration runner may disable rate limiting for its fixtures.
  process.env.DISABLE_RATE_LIMITING = 'false';
  mock.module('server-only', () => ({}));

  const { generateApiKey, hashApiKey, RATE_LIMIT_CONFIGS } = await import(
    '@feed/api'
  );
  const { chatParticipants, chats, db, eq, messages, userApiKeys, users } =
    await import('@feed/db');
  const { POST: sendMcpMessage } = await import(
    '../../../apps/web/src/app/api/mcp/route'
  );
  const { POST: sendWebMessage } = await import(
    '../../../apps/web/src/app/api/chats/[id]/message/route'
  );
  const limit = RATE_LIMIT_CONFIGS.SEND_MESSAGE.maxRequests;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/mcp') {
        const headers = new Headers(request.headers);
        // Use the real per-user key flow even though the service is local.
        headers.set('host', 'message-budget.test');
        return sendMcpMessage(new NextRequest(request, { headers }));
      }
      const id = pathname.match(/^\/api\/chats\/([^/]+)\/message$/)?.[1];
      return id
        ? sendWebMessage(new NextRequest(request), {
            params: Promise.resolve({ id }),
          })
        : new Response(null, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  async function createDirectChat() {
    const senderId = crypto.randomUUID();
    const recipientId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const stewardId = `message-budget-${senderId}`;
    const now = new Date();
    const keys = [generateApiKey(), generateApiKey()] as const;
    await db.transaction(async (tx) => {
      await tx.insert(users).values([
        { id: senderId, stewardId, updatedAt: now },
        { id: recipientId, updatedAt: now },
      ]);
      await tx.insert(userApiKeys).values(
        keys.map((key) => ({
          id: crypto.randomUUID(),
          userId: senderId,
          keyHash: hashApiKey(key),
        }))
      );
      await tx
        .insert(chats)
        .values({ id: chatId, isGroup: false, updatedAt: now });
      await tx.insert(chatParticipants).values(
        [senderId, recipientId].map((userId) => ({
          id: crypto.randomUUID(),
          chatId,
          userId,
        }))
      );
    });
    return { chatId, token: await createStewardTestToken(stewardId), keys };
  }

  async function post(
    path: string,
    headers: Record<string, string>,
    payload: object
  ) {
    return fetch(new URL(path, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
  }

  async function mcp(chatId: string, key: string, content: string) {
    const id = crypto.randomUUID();
    const response = await post(
      '/api/mcp',
      { 'X-Feed-Api-Key': key },
      {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'send_message', arguments: { chatId, content } },
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      result?: { isError: boolean; content: { text: string }[] };
    };
    expect(body.id).toBe(id);
    if (!body.result) throw new Error('Missing MCP tool result');
    return { id, ...body.result };
  }

  async function web(chatId: string, token: string, content: string) {
    const requestId = crypto.randomUUID();
    const response = await post(
      `/api/chats/${chatId}/message`,
      { authorization: `Bearer ${token}`, 'x-request-id': requestId },
      { content }
    );
    return { requestId, response };
  }

  async function storedCount(chatId: string) {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId));
    return rows.length;
  }

  async function sendAllowedMcp(
    chatId: string,
    keys: readonly [string, string],
    count: number
  ) {
    for (let sent = 0; sent < count; sent++) {
      const key = sent % 2 === 0 ? keys[0] : keys[1];
      const result = await mcp(
        chatId,
        key,
        `Automated fixture update number ${sent + 1}.`
      );
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
    }
  }

  async function expectMcpLimited(chatId: string, key: string, count: number) {
    const result = await mcp(
      chatId,
      key,
      'This message is over the shared limit.'
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Rate limit exceeded for send_message'
    );
    const stored = await storedCount(chatId);
    expect(stored).toBe(count);
    console.info('MCP message budget', {
      requestId: result.id,
      rejected: true,
      stored,
    });
  }

  test(cases.mcp, async () => {
    const { chatId, keys } = await createDirectChat();
    await sendAllowedMcp(chatId, keys, limit);
    await expectMcpLimited(chatId, keys[1], limit);
  });

  test(cases.webToMcp, async () => {
    const { chatId, token, keys } = await createDirectChat();
    const { response } = await web(
      chatId,
      token,
      'See you at the library this afternoon.'
    );
    expect(response.status).toBe(201);
    await sendAllowedMcp(chatId, keys, limit - 1);
    await expectMcpLimited(chatId, keys[0], limit);
  });

  test(cases.mcpToWeb, async () => {
    const { chatId, token, keys } = await createDirectChat();
    await sendAllowedMcp(chatId, keys, limit - 1);
    const allowed = await web(
      chatId,
      token,
      'See you at the library this afternoon.'
    );
    expect(allowed.response.status).toBe(201);
    const denied = await web(
      chatId,
      token,
      'Bring a raincoat for the walk home.'
    );
    expect(denied.response.status).toBe(429);
    const stored = await storedCount(chatId);
    expect(stored).toBe(limit);
    console.info('Web message budget', {
      requestId: denied.requestId,
      status: 429,
      stored,
    });
  });
}
