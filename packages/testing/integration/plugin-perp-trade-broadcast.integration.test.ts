/** Plugin-agent-core perp trades publish market events. PRD §§8.1 and 12, MVP Phase 3. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  perpTrade:
    'open_perp and close_perp publish perp_trade on the markets channel',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks plugin-agent-core perp trade broadcasts against disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'plugin-perp-trade-broadcast',
      file: 'packages/testing/integration/plugin-perp-trade-broadcast.integration.test.ts',
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
  type Memory = import('@elizaos/core').Memory;
  type State = import('@elizaos/core').State;
  type IAgentRuntime = import('@elizaos/core').IAgentRuntime;

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

  const { openPerpAction } = await import(
    '../../../packages/agents/src/plugins/plugin-agent-core/src/actions/open-perp'
  );
  const { closePerpAction } = await import(
    '../../../packages/agents/src/plugins/plugin-agent-core/src/actions/close-perp'
  );

  async function createUser(): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `plugin_bc_${id.slice(-10)}`,
      profileComplete: true,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    return id;
  }

  async function createPerpMarket(): Promise<string> {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const ticker = `PGBC${suffix}`.toUpperCase();
    const orgId = `plugin-bc-org-${suffix}`;
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
      name: 'Plugin Broadcast Test Org',
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
    const runtime = { agentId: userId } as IAgentRuntime;
    const message = {} as Memory;

    const opened = await openPerpAction.handler(runtime, message, {
      data: {
        actionParams: { ticker, side: 'LONG', amount: 100, leverage: 1 },
      },
    } as unknown as State);
    expect(opened?.success).toBe(true);
    const positionId = (opened?.data as { positionId?: string } | undefined)
      ?.positionId;
    if (!positionId) throw new Error('open_perp stored no position');
    const [position] = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(position?.id).toBe(positionId);
    const opens = marketEvents('perp_trade');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      action: 'open',
      ticker,
      positionId,
    });

    published.length = 0;
    const closed = await closePerpAction.handler(runtime, message, {
      data: { actionParams: { positionId } },
    } as unknown as State);
    expect(closed?.success).toBe(true);
    const closes = marketEvents('perp_trade');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      action: 'close',
      ticker,
      positionId,
    });
  });
}
