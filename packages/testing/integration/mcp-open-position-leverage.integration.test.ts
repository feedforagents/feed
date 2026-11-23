/** PRD §§8.1 and 9.3, MVP Phases 3 and 6: MCP and web require integer leverage. */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedMcpPerpFeeCases,
  verifyMcpPerpFeeChildLease,
} from './helpers/sub-market-isolation';

const fractionalLeverages = [2.5, 1.4];
const fractionalCase = (leverage: number) =>
  `MCP and web reject ${leverage}x before persisting a trade`;
const wholeCase = 'persists an MCP position at a whole-number leverage';

if (!process.env.FEED_MCP_PERP_FEE_CHILD) {
  test('checks MCP open_position leverage in a leased database', async () => {
    await runIsolatedMcpPerpFeeCases({
      name: 'mcp-integer-leverage',
      file: 'packages/testing/integration/mcp-open-position-leverage.integration.test.ts',
      cases: [...fractionalLeverages.map(fractionalCase), wholeCase],
    });
  }, 300_000);
} else {
  await verifyMcpPerpFeeChildLease();
  mock.module('server-only', () => ({}));
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const {
    balanceTransactions,
    dbWrite,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    tradingFees,
    userApiKeys,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId, PerpOpenPositionSchema } = await import(
    '@feed/shared'
  );
  const { NextRequest } = await import('next/server');
  const { z } = await import('zod');
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (
        new URL(request.url).pathname !== '/api/mcp' ||
        request.method !== 'POST'
      )
        return new Response(null, { status: 404 });
      const headers = new Headers(request.headers);
      // Exercise the user-key check on localhost.
      headers.set('host', 'owned-mcp-leverage-fixture.invalid');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(async () => {
    await server.stop(true);
  });

  async function fixture() {
    const [userId, keyId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ] as const);
    const apiKey = generateApiKey();
    const ticker = `ML${userId}`;
    const time = new Date();
    await dbWrite.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `mcp-lev-${userId}`,
        virtualBalance: '10000',
        totalDeposited: '10000',
        profileComplete: true,
        updatedAt: time,
      });
      await tx.insert(userApiKeys).values({
        id: keyId,
        userId,
        keyHash: hashApiKey(apiKey),
      });
      await tx.insert(organizationState).values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: time,
      });
      await tx.insert(perpMarketSnapshots).values({
        ticker,
        organizationId: ticker,
        currentPrice: 100,
        markPrice: 100,
        indexPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 1_000_000,
        bidDepth: 1_000_000,
        askDepth: 1_000_000,
        maxLeverage: 20,
        minOrderSize: 10,
        fundingRate: {
          ticker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: time.toISOString(),
        },
      });
    });
    return { userId, apiKey, ticker };
  }

  const rpcSchema = z.object({
    result: z.object({
      isError: z.boolean(),
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    }),
  });
  async function openPosition(
    f: { apiKey: string; ticker: string },
    leverage: number
  ) {
    const reply = await fetch(new URL('/api/mcp', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Feed-Api-Key': f.apiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'open_position',
          arguments: { ticker: f.ticker, side: 'LONG', amount: 100, leverage },
        },
      }),
    });
    expect(reply.status).toBe(200);
    const { result } = rpcSchema.parse(await reply.json());
    const [content] = result.content;
    if (!content) throw new Error('The tool response omitted its content');
    return { isError: result.isError, text: content.text };
  }

  async function state(userId: string) {
    const [positions, [wallet], ledger, fees] = await Promise.all([
      dbWrite
        .select({ size: perpPositions.size, leverage: perpPositions.leverage })
        .from(perpPositions)
        .where(eq(perpPositions.userId, userId)),
      dbWrite
        .select({ balance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId)),
      dbWrite
        .select({ id: balanceTransactions.id })
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId)),
      dbWrite
        .select({ id: tradingFees.id })
        .from(tradingFees)
        .where(eq(tradingFees.userId, userId)),
    ] as const);
    if (!wallet) throw new Error('The fixture wallet is missing');
    return { positions, balance: Number(wallet.balance), ledger, fees };
  }

  for (const leverage of fractionalLeverages) {
    test(fractionalCase(leverage), async () => {
      const f = await fixture();
      const webOrder = { ticker: f.ticker, side: 'long', size: 100, leverage };
      expect(PerpOpenPositionSchema.safeParse(webOrder).success).toBe(false);

      const before = await state(f.userId);
      const reply = await openPosition(f, leverage);
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('leverage');
      expect(reply.text).not.toMatch(/Failed query|PerpPosition|params:/i);
      expect(await state(f.userId)).toEqual(before);
    });
  }

  test(wholeCase, async () => {
    const f = await fixture();
    const webOrder = { ticker: f.ticker, side: 'long', size: 100, leverage: 2 };
    expect(PerpOpenPositionSchema.safeParse(webOrder).success).toBe(true);

    const reply = await openPosition(f, 2);
    expect(reply.isError).toBe(false);
    expect(JSON.parse(reply.text)).toMatchObject({
      position: { ticker: f.ticker, side: 'LONG', size: 100, leverage: 2 },
      marginPaid: 50,
    });
    const after = await state(f.userId);
    expect(after.positions).toEqual([{ size: 100, leverage: 2 }]);
    expect(after.balance).toBeLessThanOrEqual(9950);
    expect(after.fees).toHaveLength(1);
  });
}
