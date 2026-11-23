/** PRD §§8.1, 12 / MVP Phases 3 and 5: honor blocks on the legacy MCP group writer. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP create_group membership moderation';
const cases = {
  creatorBlock: 'excludes a member the creator blocked',
  memberBlock: 'excludes a member who blocked the creator',
  eligibility:
    'keeps eligible members and skips duplicates, missing and banned users',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP group creation in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-create-group-blocked',
      file: 'packages/testing/integration/mcp-create-group-blocked.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const {
    chatParticipants,
    chats,
    dbWrite,
    eq,
    groupMembers,
    userApiKeys,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const [creatorId, blockedId, blockerId, eligibleId, bannedId, missingId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const apiKey = generateApiKey();
  const keyId = await generateSnowflakeId();
  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values(
      [creatorId, blockedId, blockerId, eligibleId, bannedId].map((id) => ({
        id,
        username: `group-fixture-${id}`,
        isBanned: id === bannedId,
        updatedAt: new Date(),
      }))
    );
    await tx.insert(userBlocks).values([
      { id: crypto.randomUUID(), blockerId: creatorId, blockedId },
      { id: crypto.randomUUID(), blockerId, blockedId: creatorId },
    ]);
    await tx.insert(userMutes).values({
      id: crypto.randomUUID(),
      muterId: creatorId,
      mutedId: eligibleId,
    });
    await tx.insert(userApiKeys).values({
      id: keyId,
      userId: creatorId,
      keyHash: hashApiKey(apiKey),
      name: 'Group moderation fixture',
    });
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/mcp') {
        return new Response(null, { status: 404 });
      }
      const headers = new Headers(request.headers);
      headers.set('host', 'group-moderation.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));

  async function expectMembership(
    requestId: string,
    memberIds: string[],
    expected: string[]
  ) {
    const response = await fetch(new URL('/api/mcp', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: 'create_group',
          arguments: { name: 'Group moderation fixture', memberIds },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      error?: { message?: string };
      result?: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
    const result = JSON.parse(body.result?.content[0]?.text ?? '') as {
      success: boolean;
      chatId: string;
    };
    expect(result.success).toBe(true);
    const [chat] = await dbWrite
      .select({ groupId: chats.groupId })
      .from(chats)
      .where(eq(chats.id, result.chatId));
    if (!chat?.groupId) throw new Error('Missing persisted group chat');

    const [participants, members] = await Promise.all([
      dbWrite
        .select({ userId: chatParticipants.userId })
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, result.chatId)),
      dbWrite
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, chat.groupId)),
    ]);
    expect(participants.map((row) => row.userId).sort()).toEqual(expected);
    expect(members.map((row) => row.userId).sort()).toEqual(expected);
  }

  describe(suite, () => {
    test(cases.creatorBlock, () =>
      expectMembership('creator-block', [blockedId], [creatorId])
    );
    test(cases.memberBlock, () =>
      expectMembership('member-block', [blockerId], [creatorId])
    );
    test(cases.eligibility, () =>
      expectMembership(
        'eligible-members',
        [creatorId, eligibleId, eligibleId, bannedId, missingId],
        [creatorId, eligibleId].sort()
      )
    );
  });
}
