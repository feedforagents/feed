/** Autonomous agent perp trades publish market events. PRD §§8.1 and 12, MVP Phase 3. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  perpTrade:
    'open_long and close_position publish perp_trade on the markets channel',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks autonomous agent perp trade broadcasts against disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'agents-perp-trade-broadcast',
      file: 'packages/testing/integration/agents-perp-trade-broadcast.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // Record the real broadcaster's input in this child. CI runs without Redis.
  const actualApi = await import('@feed/api');
  const {
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');

  type Published = { channel: string; payload: Record<string, unknown> };
  const published: Published[] = [];
  const { broadcastToChannel: realBroadcastToChannel } = actualApi;

  mock.module('@feed/api', () => ({
    ...actualApi,
    broadcastToChannel: async (
      channel: Parameters<typeof realBroadcastToChannel>[0],
      payload: Parameters<typeof realBroadcastToChannel>[1]
    ) => {
      published.push({ channel, payload });
      await realBroadcastToChannel(channel, payload);
    },
  }));

  const { executeDirectTrade } = await import('@feed/agents');

  async function createUser(): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `agent_bc_${id.slice(-10)}`,
      profileComplete: true,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    return id;
  }

  async function createPerpMarket(): Promise<string> {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const ticker = `AGBC${suffix}`.toUpperCase();
    const orgId = `agent-bc-org-${suffix}`;
    const now = new Date();
    await db.insert(organizationState).values({
      id: orgId,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: now,
    });
    await db.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: orgId,
      name: 'Agent Broadcast Test Org',
      currentPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 0,
      volume24h: 0,
      fundingRate: {
        ticker,
        rate: 0,
        nextFundingTime: now.toISOString(),
        predictedRate: 0,
      },
    });
    return ticker;
  }

  function marketEvents(type: string): Array<Record<string, unknown>> {
    return published
      .filter((event) => event.channel === 'markets')
      .map((event) => event.payload)
      .filter((payload) => payload.type === type);
  }

  test(cases.perpTrade, async () => {
    const userId = await createUser();
    const ticker = await createPerpMarket();
    published.length = 0;

    const opened = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: ticker,
      side: 'open_long',
      amount: 100,
      skipPerpResolution: true,
    });
    expect(opened.success).toBe(true);
    const [position] = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    if (!position) throw new Error('open_long stored no position');
    const opens = marketEvents('perp_trade');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      action: 'open',
      ticker,
      positionId: position.id,
    });

    published.length = 0;
    const closed = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: ticker,
      side: 'close_position',
      amount: 0,
      skipPerpResolution: true,
    });
    expect(closed.success).toBe(true);
    const closes = marketEvents('perp_trade');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      action: 'close',
      ticker,
      positionId: position.id,
    });
  });
}
