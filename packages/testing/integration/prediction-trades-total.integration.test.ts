/**
 * Integration Test — Prediction Market Trades `total` (HTTP)
 *
 * @route GET /api/markets/predictions/[id]/trades
 * @route GET /api/markets/predictions/[id] (tradeCount parity)
 *
 * Runs against the live dev server started by
 * scripts/test-integration-with-server.ts (TEST_API_URL). Real PostgreSQL
 * (DATABASE_URL must point at a disposable DB with the drizzle migrations
 * applied). No DB mocking: fixtures are inserted as rows and both routes
 * are exercised over HTTP.
 *
 * The market detail route reports `tradeCount` for the same market as the
 * count of user pred_buy/pred_sell balance transactions plus NPC trades.
 * The trades route merges exactly those two sources, so its `total` must
 * be that same count on every page — the perps sibling route returns the
 * full merged count as `total` too.
 *
 * The balance-transaction count runs against the existing indexes;
 * a dedicated (relatedId, type) concurrent index is a separately
 * reviewed step, pending the production-like measurement of this count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  balanceTransactions,
  db,
  eq,
  gameOnboarding,
  inArray,
  markets,
  npcTrades,
  questions,
  sql,
  users,
} from '@feed/db';
import { requireServer, waitForServerAvailability } from './helpers';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 55_000;

// This fixture owns only successful RETURNING rows in explicit disposable DBs.
const database = new URL(process.env.DATABASE_URL || '');
const databasePort = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (databasePort === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      databasePort === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== process.env.DATABASE_URL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary fixture database required');
const server = new URL(BASE_URL);
if (
  server.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');

const RUN = crypto.randomUUID().replaceAll('-', '');
const ip = crypto.getRandomValues(new Uint8Array(2));
const headers = { 'x-forwarded-for': `198.19.${ip[0]}.${ip[1]}` };
const owned = {
  users: new Set<string>(),
  markets: new Set<string>(),
  balance: new Set<string>(),
  npc: new Set<string>(),
};

async function cleanup(target = owned) {
  // Any refusal rolls back the preceding child deletions as well.
  await db.transaction(async (tx) => {
    // Drain earlier FK writers before the guarded DELETE takes its snapshot.
    for (const [table, ids] of [
      [users, target.users],
      [markets, target.markets],
    ] as const) {
      if (ids.size)
        await tx
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, [...ids]))
          .orderBy(table.id)
          .for('update');
    }
    for (const [table, ids, label] of [
      [balanceTransactions, target.balance, 'BalanceTransaction'],
      [npcTrades, target.npc, 'NPCTrade'],
      [markets, target.markets, 'Market'],
      [users, target.users, 'User'],
    ] as const) {
      if (!ids.size) continue;
      const parentGuard =
        table === markets
          ? sql`NOT EXISTS (SELECT 1 FROM "Question" q WHERE q."marketId" = ${markets.id})`
          : table === users
            ? sql`NOT EXISTS (SELECT 1 FROM "GameOnboarding" x WHERE x."userId" = ${users.id})
              AND NOT EXISTS (SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId" = ${users.id})
              AND NOT EXISTS (SELECT 1 FROM "Whitelist" x WHERE x."userId" = ${users.id} OR x."grantedBy" = ${users.id})
              AND NOT EXISTS (SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy" = ${users.id})`
            : sql`true`;
      const removed = await tx
        .delete(table)
        .where(and(inArray(table.id, [...ids]), parentGuard))
        .returning({ id: table.id });
      if (removed.length !== ids.size)
        throw new Error(`Owned ${label} cleanup refused`);
      expect(removed.length).toBe(ids.size);
      expect(
        await tx
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, [...ids]))
      ).toEqual([]);
    }
  });
  for (const ids of Object.values(target)) ids.clear();
}
const MARKET_ID = `f10-market-${RUN}`;
const OTHER_MARKET_ID = `f10-other-${RUN}`;
const EMPTY_MARKET_ID = `f10-empty-${RUN}`;
const TRADER_ID = `f10-trader-${RUN}`;
const NPC_ID = `f10-npc-${RUN}`;

const BALANCE_TRADES = 25; // user pred_buy/pred_sell rows for MARKET_ID
const NPC_TRADES = 10; // NPC prediction trades for MARKET_ID
const REAL_TOTAL = BALANCE_TRADES + NPC_TRADES; // 35

const BALANCE_IDS = Array.from(
  { length: BALANCE_TRADES },
  (_, i) => `f10-bt-${RUN}-${i}`
);
const NPC_IDS = Array.from(
  { length: NPC_TRADES },
  (_, i) => `f10-npc-${RUN}-${i}`
);
const DECOY_IDS = [
  `f10-bt-${RUN}-cancel`,
  `f10-bt-${RUN}-other`,
  `f10-npc-${RUN}-perp`,
];

type TradesPage = {
  trades: Array<{ id: string; type: string; timestamp: string }>;
  total: number;
  hasMore: boolean;
};

async function getTrades(
  marketId: string,
  limit: number,
  offset: number
): Promise<{ status: number; body: TradesPage }> {
  const res = await fetch(
    `${BASE_URL}/api/markets/predictions/${marketId}/trades?limit=${limit}&offset=${offset}`,
    {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'error',
    }
  );
  return { status: res.status, body: (await res.json()) as TradesPage };
}

async function getDetailTradeCount(marketId: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/api/markets/predictions/${marketId}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
    cache: 'no-store',
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    market: { tradeCount: number };
  };
  return body.market.tradeCount;
}

describe('GET /api/markets/predictions/[id]/trades total', () => {
  beforeAll(async () => {
    requireServer(await waitForServerAvailability(BASE_URL, 15), BASE_URL);

    const now = new Date();
    const insertedUsers = await db
      .insert(users)
      .values([
        {
          id: TRADER_ID,
          username: `trader-${RUN.slice(0, 16)}`,
          displayName: 'Trader',
          updatedAt: now,
        },
        {
          id: NPC_ID,
          username: `npc-${RUN.slice(0, 16)}`,
          displayName: 'NPC',
          isActor: true,
          updatedAt: now,
        },
      ])
      .returning({ id: users.id });
    for (const row of insertedUsers) owned.users.add(row.id);
    const insertedMarkets = await db
      .insert(markets)
      .values([
        {
          id: MARKET_ID,
          question: 'Will the F10 fixture resolve yes?',
          liquidity: '1000',
          endDate: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          updatedAt: now,
        },
        {
          id: OTHER_MARKET_ID,
          question: 'Unrelated market',
          liquidity: '1000',
          endDate: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          updatedAt: now,
        },
        {
          id: EMPTY_MARKET_ID,
          question: 'Market with no trades yet',
          liquidity: '1000',
          endDate: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
          updatedAt: now,
        },
      ])
      .returning({ id: markets.id });
    for (const row of insertedMarkets) owned.markets.add(row.id);

    // 25 user trades on this market, one per minute, alternating buy/sell.
    const balanceRows: Array<typeof balanceTransactions.$inferInsert> =
      BALANCE_IDS.map((id, i) => ({
        id,
        userId: TRADER_ID,
        type: i % 2 === 0 ? 'pred_buy' : 'pred_sell',
        amount: '10',
        balanceBefore: '100',
        balanceAfter: '90',
        relatedId: MARKET_ID,
        createdAt: new Date(now.getTime() - (100 + i) * 60_000),
      }));
    // Decoys that must NOT be counted: a refund row on this market and
    // trades belonging to another market.
    balanceRows.push(
      {
        id: `f10-bt-${RUN}-cancel`,
        userId: TRADER_ID,
        type: 'pred_cancel',
        amount: '10',
        balanceBefore: '100',
        balanceAfter: '110',
        relatedId: MARKET_ID,
        createdAt: new Date(now.getTime() - 30 * 60_000),
      },
      {
        id: `f10-bt-${RUN}-other`,
        userId: TRADER_ID,
        type: 'pred_buy',
        amount: '10',
        balanceBefore: '100',
        balanceAfter: '90',
        relatedId: OTHER_MARKET_ID,
        createdAt: new Date(now.getTime() - 20 * 60_000),
      }
    );
    const insertedBalance = await db
      .insert(balanceTransactions)
      .values(balanceRows)
      .returning({ id: balanceTransactions.id });
    for (const row of insertedBalance) owned.balance.add(row.id);

    // 10 NPC prediction trades on this market, one per minute.
    const npcRows: Array<typeof npcTrades.$inferInsert> = NPC_IDS.map(
      (id, i) => ({
        id,
        npcActorId: NPC_ID,
        marketType: 'prediction',
        marketId: MARKET_ID,
        action: 'buy',
        side: 'yes',
        amount: 5,
        price: 0.5,
        executedAt: new Date(now.getTime() - (50 + i) * 60_000),
      })
    );
    // Decoy: an NPC perp trade that happens to carry the same marketId.
    npcRows.push({
      id: `f10-npc-${RUN}-perp`,
      npcActorId: NPC_ID,
      marketType: 'perp',
      marketId: MARKET_ID,
      action: 'buy',
      side: 'long',
      amount: 5,
      price: 0.5,
      executedAt: new Date(now.getTime() - 10 * 60_000),
    });
    const insertedNpc = await db
      .insert(npcTrades)
      .values(npcRows)
      .returning({ id: npcTrades.id });
    for (const row of insertedNpc) owned.npc.add(row.id);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('reports the full merged trade count as total on the first page', async () => {
    const { status, body: page } = await getTrades(MARKET_ID, 20, 0);
    expect(status).toBe(200);
    expect(page.trades.length).toBe(20);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(REAL_TOTAL);
  });

  it('reports the same total on the last page', async () => {
    const { status, body: page } = await getTrades(MARKET_ID, 20, 20);
    expect(status).toBe(200);
    expect(page.trades.length).toBe(REAL_TOTAL - 20);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(REAL_TOTAL);
  });

  it('reports the full total with an empty page past the end', async () => {
    const { status, body: page } = await getTrades(MARKET_ID, 20, 100);
    expect(status).toBe(200);
    expect(page.trades.length).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(REAL_TOTAL);
  });

  it('reports zero trades and zero total for a market with no trades', async () => {
    const { status, body: page } = await getTrades(EMPTY_MARKET_ID, 20, 0);
    expect(status).toBe(200);
    expect(page.trades.length).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(0);
    expect(await getDetailTradeCount(EMPTY_MARKET_ID)).toBe(0);
  });

  it('agrees with the market detail tradeCount for the same market', async () => {
    const tradeCount = await getDetailTradeCount(MARKET_ID);
    expect(tradeCount).toBe(REAL_TOTAL);

    const { body: page } = await getTrades(MARKET_ID, 20, 0);
    expect(page.total).toBe(tradeCount);
  });

  it('merges balance and NPC trades in one time-descending feed without decoys', async () => {
    const { status, body: page } = await getTrades(MARKET_ID, 35, 0);
    expect(status).toBe(200);
    expect(page.trades.length).toBe(REAL_TOTAL);
    expect(page.total).toBe(REAL_TOTAL);

    // One minute apart, so the merged feed must be strictly descending.
    const timestamps = page.trades.map((t) => new Date(t.timestamp).getTime());
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]!).toBeLessThan(timestamps[i - 1]!);
    }
    // NPC rows are the newest fixtures, balance rows the oldest.
    expect(page.trades[0]!.type).toBe('npc');
    expect(page.trades[page.trades.length - 1]!.type).toBe('balance');
    expect(new Set(page.trades.map((t) => t.type)).size).toBe(2);

    // The full page must contain exactly the counted fixtures — no decoy
    // (pred_cancel row, other-market row, perp NPC row) may leak in.
    expect(new Set(page.trades.map((t) => t.id))).toEqual(
      new Set([...BALANCE_IDS, ...NPC_IDS])
    );
    for (const decoyId of DECOY_IDS) {
      expect(page.trades.map((t) => t.id)).not.toContain(decoyId);
    }
  });

  it('keeps the complete total across deep and small page walks', async () => {
    const walked: string[] = [];
    for (let offset = 0; offset <= REAL_TOTAL; offset += 7) {
      const { status, body } = await getTrades(MARKET_ID, 7, offset);
      expect(status).toBe(200);
      expect(body.total).toBe(REAL_TOTAL);
      expect(body.hasMore).toBe(offset + 7 < REAL_TOTAL);
      walked.push(...body.trades.map((row) => row.id));
    }
    expect(walked).toHaveLength(REAL_TOTAL);
    expect(new Set(walked)).toEqual(new Set([...BALANCE_IDS, ...NPC_IDS]));
    const deep = await getTrades(MARKET_ID, 1, 10_000);
    expect(deep.status).toBe(200);
    expect(deep.body.trades).toEqual([]);
    expect(deep.body.total).toBe(REAL_TOTAL);
    expect(deep.body.hasMore).toBe(false);
  });

  it('preserves missing-market and invalid-window responses', async () => {
    for (const [path, expected] of [
      [`/api/markets/predictions/f10-absent-${RUN}/trades`, 404],
      [`/api/markets/predictions/${MARKET_ID}/trades?limit=0`, 400],
      [`/api/markets/predictions/${MARKET_ID}/trades?offset=10001`, 400],
    ] as const) {
      const response = await fetch(BASE_URL + path, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      expect(response.status).toBe(expected);
      await response.arrayBuffer();
    }
  });

  it('partial setup cleanup cannot delete a colliding existing user or its trades', async () => {
    const partial = new Set<string>(),
      failed = new Set<string>();
    const id = `f10-partial-${crypto.randomUUID()}`;
    const laterId = `f10-uninserted-${crypto.randomUUID()}`;
    async function insert(
      rows: Array<typeof users.$inferInsert>,
      ownership: Set<string>
    ) {
      const inserted = await db
        .insert(users)
        .values(rows)
        .returning({ id: users.id });
      for (const row of inserted) ownership.add(row.id);
    }
    async function remove(ownership: Set<string>) {
      await cleanup({
        users: ownership,
        markets: new Set(),
        balance: new Set(),
        npc: new Set(),
      });
    }
    try {
      await insert([{ id, updatedAt: new Date() }], partial);
      await expect(
        insert(
          [
            { id: TRADER_ID, updatedAt: new Date() },
            { id: laterId, updatedAt: new Date() },
          ],
          failed
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(failed.size).toBe(0);
      await remove(failed);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, TRADER_ID))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, laterId))
      ).toEqual([]);
      expect(
        await db
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
          .where(inArray(balanceTransactions.id, BALANCE_IDS))
      ).toHaveLength(BALANCE_TRADES);
    } finally {
      await remove(partial);
    }
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, id))
    ).toEqual([]);
  });

  it('refuses foreign question and onboarding references without partially deleting owned trades', async () => {
    const questionRows: Array<{ id: string; canonical: string }> = [];
    const onboardingRows: Array<{ id: string; canonical: string }> = [];
    const failures: Error[] = [];
    async function retainedFixtures() {
      for (const [table, ids] of [
        [balanceTransactions, owned.balance],
        [npcTrades, owned.npc],
        [markets, owned.markets],
        [users, owned.users],
      ] as const) {
        expect(
          new Set(
            (
              await db
                .select({ id: table.id })
                .from(table)
                .where(inArray(table.id, [...ids]))
            ).map((row) => row.id)
          )
        ).toEqual(ids);
      }
    }
    async function removeQuestion() {
      for (const row of questionRows) {
        const removed = await db
          .delete(questions)
          .where(
            and(
              eq(questions.id, row.id),
              sql`to_jsonb(${questions}) = ${row.canonical}::text::jsonb`
            )
          )
          .returning({ id: questions.id });
        expect(removed).toEqual([{ id: row.id }]);
      }
      questionRows.length = 0;
    }
    try {
      const now = new Date();
      questionRows.push(
        ...(await db
          .insert(questions)
          .values({
            id: `f10-foreign-question-${RUN}`,
            questionNumber:
              crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000,
            marketId: MARKET_ID,
            text: 'Separate ownership control',
            scenarioId: -1,
            outcome: false,
            rank: 0,
            resolutionDate: now,
            updatedAt: now,
          })
          .returning({
            id: questions.id,
            canonical: sql<string>`to_jsonb(${questions})::text`,
          }))
      );
      onboardingRows.push(
        ...(await db
          .insert(gameOnboarding)
          .values({ id: `f10-foreign-onboarding-${RUN}`, userId: TRADER_ID })
          .returning({
            id: gameOnboarding.id,
            canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
          }))
      );
      expect(questionRows).toHaveLength(1);
      expect(onboardingRows).toHaveLength(1);
      await expect(cleanup()).rejects.toThrow('Owned Market cleanup refused');
      await retainedFixtures();
      expect(
        await db
          .select({
            id: questions.id,
            canonical: sql<string>`to_jsonb(${questions})::text`,
          })
          .from(questions)
          .where(eq(questions.id, questionRows[0]!.id))
      ).toEqual(questionRows);
      await removeQuestion();
      await expect(cleanup()).rejects.toThrow('Owned User cleanup refused');
      await retainedFixtures();
      expect(
        await db
          .select({
            id: gameOnboarding.id,
            canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
          })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, onboardingRows[0]!.id))
      ).toEqual(onboardingRows);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
    } finally {
      try {
        await removeQuestion();
        for (const row of onboardingRows) {
          const removed = await db
            .delete(gameOnboarding)
            .where(
              and(
                eq(gameOnboarding.id, row.id),
                sql`to_jsonb(${gameOnboarding}) = ${row.canonical}::text::jsonb`
              )
            )
            .returning({ id: gameOnboarding.id });
          expect(removed).toEqual([{ id: row.id }]);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Ownership refusal control failed');
  });
});
