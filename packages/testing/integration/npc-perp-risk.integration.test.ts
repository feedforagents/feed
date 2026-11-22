/** Retained NPC risk handling under PRD §§9.1/9.3 and MVP Phase 6. */
import { afterAll, expect, test } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const closeCase = 'selects a marked live perp once and settles its close once';
const profitCase = 'uses margin for shorts and preserves prediction cost basis';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs NPC risk and close cases in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'npc-perp-risk',
      file: 'packages/testing/integration/npc-perp-risk.integration.test.ts',
      cases: [closeCase, profitCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    actorState,
    and,
    db,
    eq,
    npcTrades,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    poolPositions,
    pools,
    users,
  } = await import('@feed/db');
  const { TradeExecutionService } = await import('@feed/engine');
  const { canonicalTradingFee, generateSnowflakeId } = await import(
    '@feed/shared'
  );
  const { FEE_CONFIG } = await import('../../engine/src/config/fees');
  const { createNpcWalletAdapter } = await import(
    '../../engine/src/services/npc-wallet-adapter'
  );
  const { createPerpSettlement } = await import(
    '../../engine/src/services/perp-settlement'
  );
  const cronSecret = crypto.randomUUID();
  process.env.CRON_SECRET = cronSecret;
  const { POST } = await import(
    '../../../apps/web/src/app/api/npc/[actorId]/invest/route'
  );

  const actionsSchema = z.object({
    actions: z.array(
      z.object({
        type: z.enum(['close', 'profit_take']),
        positionId: z.string(),
        marketType: z.enum(['perp', 'prediction']),
        ticker: z.string().optional(),
        marketId: z.string().optional(),
        side: z.string(),
        targetSize: z.number(),
        reason: z.string(),
      })
    ),
  });
  const executedSchema = z.object({ actionsExecuted: z.number() });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const actorId = /^\/api\/npc\/(\d+)\/invest$/.exec(path)?.[1];
      if (request.method !== 'POST' || !actorId) {
        return new Response(null, { status: 404 });
      }
      return POST(new NextRequest(request), {
        params: Promise.resolve({ actorId }),
      });
    },
  });
  afterAll(async () => {
    await server.stop(true);
  });

  function request(actorId: string, body: object) {
    return fetch(new URL(`/api/npc/${actorId}/invest`, server.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cronSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function monitor(
    actorId: string,
    strategy: 'conservative' | 'aggressive' = 'aggressive'
  ) {
    const response = await request(actorId, { action: 'monitor', strategy });
    expect(response.status).toBe(200);
    return actionsSchema.parse(await response.json()).actions;
  }

  async function createActor(tradingBalance: string): Promise<string> {
    const id = await generateSnowflakeId();
    const updatedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        username: `risk-${id}`,
        isActor: true,
        updatedAt,
      });
      await tx
        .insert(actorState)
        .values({ id, tradingBalance, hasPool: true, updatedAt });
      await tx.insert(pools).values({
        id,
        npcActorId: id,
        name: 'NPC risk test pool',
        updatedAt,
      });
    });
    return id;
  }

  async function openPerp(
    actorId: string,
    market: { ticker: string; organizationId: string },
    action: 'open_long' | 'open_short'
  ) {
    await db.insert(organizationState).values({
      id: market.organizationId,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await db.insert(perpMarketSnapshots).values({
      ...market,
      currentPrice: 100,
      high24h: 100,
      low24h: 100,
      fundingRate: {
        ticker: market.ticker,
        rate: 0,
        predictedRate: 0,
        nextFundingTime: new Date().toISOString(),
      },
    });
    const { positionId } =
      await new TradeExecutionService().executeSingleDecision({
        npcId: actorId,
        npcName: 'NPC risk test actor',
        action,
        marketType: 'perp',
        ticker: market.ticker,
        confidence: 1,
        amount: 1000,
        reasoning: 'Open a fixture position for the normal NPC risk path',
      });
    if (!positionId) throw new Error('NPC open returned no position ID');
    return readPerp(positionId);
  }

  async function readPerp(id: string) {
    const [row] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, id));
    if (!row) throw new Error('Expected a persisted canonical position');
    return row;
  }

  async function markPerp(
    actorId: string,
    position: Awaited<ReturnType<typeof readPerp>>
  ) {
    const market = new PerpMarketService({
      db: new PerpDbAdapter(),
      wallet: createNpcWalletAdapter(actorId),
      settlement: createPerpSettlement({
        system: 'npc_perp_trade',
        wallet: (id, tx) => createNpcWalletAdapter(id, tx),
      }),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
    expect(
      await market.applyPriceUpdates({
        [position.ticker]: position.entryPrice * 0.94,
      })
    ).toMatchObject({ positionsUpdated: 1, liquidations: 0, errors: [] });
  }

  async function balance(actorId: string) {
    const [row] = await db
      .select({ balance: actorState.tradingBalance })
      .from(actorState)
      .where(eq(actorState.id, actorId));
    if (!row) throw new Error('Expected a persisted NPC actor');
    return Number(row.balance);
  }

  function legacyPerp(poolId: string, id: string) {
    return {
      id,
      poolId,
      marketType: 'perp',
      ticker: 'LEGACY',
      side: 'long',
      size: 100,
      entryPrice: 100,
      currentPrice: 100,
      leverage: 5,
      unrealizedPnL: 0,
      updatedAt: new Date(),
    };
  }

  test(closeCase, async () => {
    const actorId = await createActor('1120');
    const foreignActor = await createActor('10000');
    const opened = await openPerp(
      actorId,
      { ticker: 'NVDAI', organizationId: 'nvidai' },
      'open_long'
    );
    const margin = opened.size / opened.leverage;
    const fee = canonicalTradingFee(opened.size, FEE_CONFIG.TRADING_FEE_RATE);
    expect(await balance(actorId)).toBeCloseTo(1120 - margin - fee, 2);
    expect(await monitor(actorId)).toEqual([]);

    const foreign = legacyPerp(foreignActor, 'risk-foreign');
    await db.insert(poolPositions).values([
      // Closed positions outrank the live ones by leverage but must not
      // take any of the de-risking slots.
      ...[0, 1, 2].map((index) => ({
        ...legacyPerp(actorId, `risk-closed-${index}`),
        leverage: 10,
        closedAt: new Date(),
      })),
      legacyPerp(actorId, 'risk-legacy-b'),
      legacyPerp(actorId, 'risk-legacy-a'),
      legacyPerp(actorId, 'risk-legacy-c'),
      legacyPerp(actorId, opened.id),
      { ...foreign, unrealizedPnL: -100 },
    ]);
    await markPerp(actorId, opened);
    const [action] = await monitor(actorId);
    expect(action).toMatchObject({
      type: 'close',
      positionId: opened.id,
      reason: expect.stringContaining('Stop-loss'),
    });
    const deRisk = await monitor(actorId, 'conservative');
    expect(deRisk.map(({ positionId }) => positionId)).toEqual([
      opened.id,
      'risk-legacy-a',
    ]);
    expect(deRisk.every(({ reason }) => reason.startsWith('De-risking'))).toBe(
      true
    );

    const beforeClose = await balance(actorId);
    const closed = await request(actorId, {
      action: 'rebalance',
      strategy: 'aggressive',
    });
    expect(closed.status).toBe(200);
    expect(executedSchema.parse(await closed.json()).actionsExecuted).toBe(1);
    const settled = await readPerp(opened.id);
    if (settled.realizedPnL === null) throw new Error('Missing persisted P&L');
    expect(settled.closedAt).toBeInstanceOf(Date);
    expect(settled.unrealizedPnL).toBe(0);
    expect(settled.realizedPnL).toBeLessThan(0);
    const afterClose = await balance(actorId);
    expect(afterClose).toBeCloseTo(
      beforeClose + margin + settled.realizedPnL - fee,
      2
    );

    expect(await monitor(actorId)).toEqual([]);
    const replay = await request(actorId, {
      action: 'execute',
      rebalanceAction: action,
    });
    expect(replay.ok).toBe(false);
    expect(await balance(actorId)).toBe(afterClose);
    const closes = await db
      .select({ id: npcTrades.id })
      .from(npcTrades)
      .where(
        and(eq(npcTrades.npcActorId, actorId), eq(npcTrades.action, 'close'))
      );
    expect(closes).toHaveLength(1);
    const [legacyMirror] = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.id, opened.id));
    expect(legacyMirror?.closedAt).toBeNull();
    expect(await balance(foreignActor)).toBe(10000);
    const [otherPosition] = await db
      .select({
        closedAt: poolPositions.closedAt,
        unrealizedPnL: poolPositions.unrealizedPnL,
      })
      .from(poolPositions)
      .where(eq(poolPositions.id, foreign.id));
    expect(otherPosition).toEqual({ closedAt: null, unrealizedPnL: -100 });
  });

  test(profitCase, async () => {
    const actorId = await createActor('10000');
    const opened = await openPerp(
      actorId,
      { ticker: 'TSLAI', organizationId: 'teslai' },
      'open_short'
    );
    await db.insert(poolPositions).values([
      legacyPerp(actorId, opened.id),
      {
        ...legacyPerp(actorId, 'risk-prediction'),
        marketType: 'prediction',
        ticker: null,
        marketId: 'risk-prediction-market',
        leverage: null,
        side: 'YES',
        unrealizedPnL: 30,
      },
    ]);
    await markPerp(actorId, opened);
    const actions = await monitor(actorId);
    expect(
      actions.map(({ positionId, type }) => [positionId, type]).sort()
    ).toEqual(
      [
        [opened.id, 'profit_take'],
        ['risk-prediction', 'profit_take'],
      ].sort()
    );
    expect(
      actions.find(({ positionId }) => positionId === opened.id)?.reason
    ).toContain('30.0%');
  });
}
