/**
 * PRD §3 goal 6, §§8.2/9.2 / MVP Phase 6: executed NPC predictions appear
 * in market history. These are real deterministic service/HTTP calls, not LLM
 * decisions. The fixed fresh child owns its static actor state and all effects.
 */
import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runIsolatedNpcTradeCountCases,
  startNpcTradeCountServer,
  verifyNpcTradeCountChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_NPC_TRADE_COUNT_CHILD) {
  test('runs six real NPC history cases in a leased fresh database', async () => {
    await runIsolatedNpcTradeCountCases();
  }, 300_000);
} else {
  await verifyNpcTradeCountChildLease();
  const leaseFile = process.env.FEED_NPC_TRADE_COUNT_LEASE_FILE;
  if (!leaseFile) throw new Error('Verified NPC child lease required');
  const directory = dirname(leaseFile);
  const receipts = join(directory, 'fixture-receipts.jsonl');
  writeFileSync(receipts, '', { flag: 'wx', mode: 0o600 });
  // Application clients are imported only after verifying the actual child.
  const { executeDirectTrade } = await import('@feed/agents');
  const {
    actorState,
    and,
    closeDatabase,
    dbWrite,
    eq,
    npcTrades,
    positions,
    sql,
  } = await import('@feed/db');
  const { TradeExecutionService, setCacheInvalidationClient } = await import(
    '@feed/engine'
  );
  const { invalidateCachePattern, getCache } = await import('@feed/api');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { z } = await import('zod');
  const { default: postgres } = await import('postgres');
  const { GET: sourceTradesGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/trades/route'
  );
  const NPC_ID = 'ailon-musk'; // Genuine StaticDataRegistry actor; never borrowed.
  const ENGINE_ACTOR_ID = `owned-history-${await generateSnowflakeId()}`;
  const MARKET_ID = await generateSnowflakeId();
  const CACHE_MARKET_ID = await generateSnowflakeId();
  let server: Awaited<ReturnType<typeof startNpcTradeCountServer>> | undefined;
  const detailSchema = z.object({
    market: z.object({ tradeCount: z.number().int().nonnegative() }),
  });
  const tradesSchema = z.object({
    trades: z.array(z.object({ id: z.string(), type: z.string() })),
    total: z.number().int().nonnegative(),
  });
  function receipt(label: string, data: object) {
    appendFileSync(receipts, JSON.stringify({ label, data }) + '\n');
  }
  async function detailCount() {
    if (!server) throw new Error('Owned Next server required');
    const response = await fetch(
      `${server.url}/api/markets/predictions/${MARKET_ID}`,
      { redirect: 'error', signal: AbortSignal.timeout(5000) }
    );
    expect(response.status).toBe(200);
    return detailSchema.parse(await response.json()).market.tradeCount;
  }
  async function shares(actor: string, marketId = MARKET_ID) {
    const rows = await dbWrite
      .select({ shares: positions.shares, status: positions.status })
      .from(positions)
      .where(
        and(eq(positions.userId, actor), eq(positions.marketId, marketId))
      );
    return rows
      .filter((row) => row.status === 'active')
      .reduce((sum, row) => sum + Number(row.shares), 0);
  }
  async function state() {
    const rows = await dbWrite.execute<{ row: string }>(
      sql`SELECT to_jsonb(t)::text AS row FROM "ActorState" t WHERE id=${NPC_ID}`
    );
    return Array.from(rows);
  }
  async function mirrored(marketId = MARKET_ID) {
    return Array.from(
      await dbWrite
        .select({ id: npcTrades.id })
        .from(npcTrades)
        .where(
          and(
            eq(npcTrades.npcActorId, NPC_ID),
            eq(npcTrades.marketId, marketId),
            eq(npcTrades.marketType, 'prediction')
          )
        )
    );
  }
  // Same adapter as web instrumentation, using real CacheService memory here.
  // Its scope is this process; the separate Next process is not cache evidence.
  setCacheInvalidationClient({
    deleteByPattern: async (pattern) => {
      await invalidateCachePattern(pattern);
      return 0;
    },
  });
  afterAll(async () => {
    try {
      await server?.stop();
    } finally {
      await closeDatabase();
    }
  }, 15_000);
  describe('prediction market detail tradeCount (all NPC execution paths)', () => {
    beforeAll(async () => {
      const existing = await dbWrite
        .select({ id: actorState.id })
        .from(actorState)
        .where(eq(actorState.id, NPC_ID));
      expect(existing).toHaveLength(0);
      // One atomic setup; only successful INSERT RETURNING acquires physical rows.
      const acquired = await dbWrite.execute<{
        table: string;
        id: string;
        row: string;
      }>(sql`
        WITH a AS (
          INSERT INTO "ActorState" (id,"tradingBalance","updatedAt") VALUES
          (${NPC_ID},10000,now()),(${ENGINE_ACTOR_ID},10000,now())
          RETURNING id,to_jsonb("ActorState")::text AS row
        ), m AS (
          INSERT INTO "Market" (id,question,"yesShares","noShares",liquidity,"endDate","updatedAt") VALUES
          (${MARKET_ID},'Owned NPC history main',5000,5000,10000,now()+interval '7 days',now()),
          (${CACHE_MARKET_ID},'Owned NPC history cache barrier',5000,5000,10000,now()+interval '7 days',now())
          RETURNING id,to_jsonb("Market")::text AS row
        ) SELECT 'ActorState' AS table,id,row FROM a UNION ALL SELECT 'Market' AS table,id,row FROM m
      `);
      receipt('setup-successful-physical-returning', {
        rows: Array.from(acquired),
      });
      expect(acquired).toHaveLength(4);
      server = await startNpcTradeCountServer();
      expect(await detailCount()).toBe(0);
    }, 60_000);

    it('counts an autonomous-loop NPC buy (executeDirectTrade)', async () => {
      const result = await executeDirectTrade({
        agentUserId: NPC_ID,
        marketType: 'prediction',
        marketId: MARKET_ID,
        side: 'buy_yes',
        amount: 50,
        reasoning: 'owned history buy',
      });
      receipt('direct-buy', {
        result,
        actor: await state(),
        mirrors: await mirrored(),
      });
      expect(result.success).toBe(true);
      expect(await shares(NPC_ID)).toBeGreaterThan(0);
      expect(await detailCount()).toBe(1);
    });

    it('counts an autonomous-loop NPC sell (executeDirectTrade)', async () => {
      const result = await executeDirectTrade({
        agentUserId: NPC_ID,
        marketType: 'prediction',
        marketId: MARKET_ID,
        side: 'sell_yes',
        amount: 0,
        reasoning: 'owned history sell',
      });
      receipt('direct-sell', {
        result,
        actor: await state(),
        mirrors: await mirrored(),
      });
      expect(result.success).toBe(true);
      expect(await shares(NPC_ID)).toBe(0);
      expect(await detailCount()).toBe(2);
    });

    it('counts a TradeExecutionService NPC buy exactly once (control)', async () => {
      const service = new TradeExecutionService();
      await service.executeSingleDecision({
        npcId: ENGINE_ACTOR_ID,
        npcName: 'Owned history control',
        action: 'buy_no',
        marketType: 'prediction',
        marketId: MARKET_ID,
        amount: 50,
        confidence: 0.8,
        reasoning: 'owned engine control',
      });
      expect(await shares(ENGINE_ACTOR_ID)).toBeGreaterThan(0);
      expect(await detailCount()).toBe(3);
    });

    it('lists every executed trade in the market trades feed', async () => {
      if (!server) throw new Error('Owned Next server required');
      const response = await fetch(
        `${server.url}/api/markets/predictions/${MARKET_ID}/trades?limit=100&offset=0`,
        { redirect: 'error', signal: AbortSignal.timeout(5000) }
      );
      expect(response.status).toBe(200);
      const body = tradesSchema.parse(await response.json());
      expect(body.total).toBe(3);
      expect(body.trades).toHaveLength(3);
      expect(body.trades.every((trade) => trade.type === 'npc')).toBe(true);
    });

    it('a failed sell creates no phantom mirror or wallet change', async () => {
      const before = { actor: await state(), mirrors: await mirrored() };
      await expect(
        executeDirectTrade({
          agentUserId: NPC_ID,
          marketType: 'prediction',
          marketId: MARKET_ID,
          side: 'sell_yes',
          amount: 0,
          reasoning: 'owned repeated closed sell',
        })
      ).rejects.toThrow('No open position');
      const after = { actor: await state(), mirrors: await mirrored() };
      receipt('failed-sell-unchanged', { before, after });
      expect(after).toEqual(before);
      expect(await detailCount()).toBe(3);
    });

    it('invalidates a same-process feed cached while its mirror insert waits', async () => {
      const url = process.env.DIRECT_DATABASE_URL;
      if (!url) throw new Error('Verified child URL required');
      const holder = postgres(url, {
        max: 1,
        connect_timeout: 5,
        connection: {
          statement_timeout: 5000,
          idle_in_transaction_session_timeout: 5000,
        },
        onnotice: () => {},
      });
      const observer = postgres(url, {
        max: 1,
        connect_timeout: 5,
        connection: { statement_timeout: 1000 },
        onnotice: () => {},
      });
      let unlock = () => {};
      const release = new Promise<void>((done) => {
        unlock = done;
      });
      let locked = (_pid: number) => {};
      const acquired = new Promise<number>((done) => {
        locked = done;
      });
      const holding = holder.begin(async (tx) => {
        await tx.unsafe('LOCK TABLE public."NPCTrade" IN SHARE MODE');
        const [row] = await tx.unsafe<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid'
        );
        if (!row) throw new Error('Missing owned holder PID');
        locked(row.pid);
        await release;
      });
      let trade: ReturnType<typeof executeDirectTrade> | undefined;
      try {
        const holderPID = await acquired;
        let completed = false;
        trade = executeDirectTrade({
          agentUserId: NPC_ID,
          marketType: 'prediction',
          marketId: CACHE_MARKET_ID,
          side: 'buy_yes',
          amount: 50,
          reasoning: 'owned post-mirror cache barrier',
        });
        void trade.then(
          () => {
            completed = true;
          },
          () => {
            completed = true;
          }
        );
        let waiting: Array<{ pid: number; holder: number }> = [];
        const deadline = performance.now() + 700;
        while (!completed && performance.now() < deadline) {
          waiting = await observer<{ pid: number; holder: number }[]>`
            SELECT a.pid,${holderPID}::int AS holder FROM pg_stat_activity a
            WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database())
              AND ${holderPID}::int=ANY(pg_blocking_pids(a.pid))
              AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public."NPCTrade"'::regclass AND NOT l.granted)`;
          if (waiting.length) break;
          await Bun.sleep(5);
        }
        receipt('actual-npc-mirror-wait', {
          holderPID,
          waiting: Array.from(waiting),
          completed,
        });
        expect(waiting).toHaveLength(1);
        // Actual source GET + CacheService in this Bun process. It is a component
        // call, not the independent Next host or a Redis/cross-process claim.
        const request = () =>
          new NextRequest(
            `http://127.0.0.1/api/markets/predictions/${CACHE_MARKET_ID}/trades?limit=100&offset=0`
          );
        const cached = await sourceTradesGET(request(), {
          params: Promise.resolve({ id: CACHE_MARKET_ID }),
        });
        const before = tradesSchema.parse(await cached.json());
        expect(before.total).toBe(0);
        expect(
          await getCache(`prediction-trades:v2:${CACHE_MARKET_ID}:100:0`, {
            namespace: 'market-trades',
          })
        ).not.toBeNull();
        const warmedAt = performance.now();
        unlock();
        await holding;
        expect((await trade).success).toBe(true);
        // Check well before the actual 10-second TTL could explain freshness.
        expect(performance.now() - warmedAt).toBeLessThan(2000);
        expect(
          await getCache(`prediction-trades:v2:${CACHE_MARKET_ID}:100:0`, {
            namespace: 'market-trades',
          })
        ).toBeNull();
        const fresh = await sourceTradesGET(request(), {
          params: Promise.resolve({ id: CACHE_MARKET_ID }),
        });
        const after = tradesSchema.parse(await fresh.json());
        receipt('same-process-real-cache-get', {
          before,
          after,
          elapsedMs: performance.now() - warmedAt,
        });
        expect(after.total).toBe(1);
        expect(after.trades).toHaveLength(1);
        expect(after.trades[0]?.type).toBe('npc');
        expect(await shares(NPC_ID, CACHE_MARKET_ID)).toBeGreaterThan(0);
      } finally {
        unlock();
        await holding;
        try {
          await trade;
        } finally {
          await Promise.all([
            holder.end({ timeout: 5 }),
            observer.end({ timeout: 5 }),
          ]);
        }
      }
    });
  });
}
