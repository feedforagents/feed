/**
 * PRD §8.2/§9.2, MVP Phase 6: stable prediction trade-history pages for
 * unchanged rows. Real public HTTP/PostgreSQL; no route mock, quota bypass,
 * or snapshot claim across concurrent writes. Ownership starts at committed
 * physical INSERT RETURNING, never at an intended fixture ID.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  markets,
  npcTrades,
  questions,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { requireServer, waitForServerAvailability } from './helpers';

const databaseUrl = process.env.DATABASE_URL || '';
const database = new URL(databaseUrl);
const databasePort = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
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
  process.env.DIRECT_DATABASE_URL !== databaseUrl ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(base);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
for (const configured of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (configured && new URL(configured).origin !== server.origin)
    throw new Error('Fixture HTTP origins must agree');

type StoredRow = { id: string; canonical: string };
function ownership() {
  return {
    User: new Map<string, string>(),
    Market: new Map<string, string>(),
    BalanceTransaction: new Map<string, string>(),
    NPCTrade: new Map<string, string>(),
    Question: new Map<string, string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
type Table = keyof Ownership;
const owned = ownership();
const deletionOrder: Table[] = [
  'BalanceTransaction',
  'NPCTrade',
  'Question',
  'Market',
  'User',
];
function acquire(
  target: Map<string, string>,
  rows: StoredRow[],
  expected: number
) {
  // Callers await autocommit before registering full physical receipts.
  for (const row of rows) target.set(row.id, row.canonical);
  if (rows.length !== expected) throw new Error('Incomplete fixture RETURNING');
}
async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  target = owned
) {
  const rows = await dbWrite
    .insert(users)
    .values(values)
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  acquire(target.User, rows, values.length);
}
async function insertMarkets(
  values: Array<typeof markets.$inferInsert>,
  target = owned
) {
  const rows = await dbWrite
    .insert(markets)
    .values(values)
    .returning({
      id: markets.id,
      canonical: sql<string>`to_jsonb(${markets})::text`,
    });
  acquire(target.Market, rows, values.length);
}
async function insertBalance(
  values: Array<typeof balanceTransactions.$inferInsert>,
  target = owned
) {
  const rows = await dbWrite
    .insert(balanceTransactions)
    .values(values)
    .returning({
      id: balanceTransactions.id,
      canonical: sql<string>`to_jsonb(${balanceTransactions})::text`,
    });
  acquire(target.BalanceTransaction, rows, values.length);
}
async function insertNpc(values: Array<typeof npcTrades.$inferInsert>) {
  const rows = await dbWrite
    .insert(npcTrades)
    .values(values)
    .returning({
      id: npcTrades.id,
      canonical: sql<string>`to_jsonb(${npcTrades})::text`,
    });
  acquire(owned.NPCTrade, rows, values.length);
}
async function cleanup(target = owned) {
  if (Object.values(target).every((rows) => rows.size === 0)) return;
  await dbWrite.transaction(async (tx) => {
    // Drain earlier FK inserts before the guarded DELETE's fresh snapshot.
    for (const table of ['User', 'Market', 'Question'] as const) {
      const ids = [...target[table].keys()].sort();
      if (ids.length)
        await tx.execute(sql`
        SELECT id FROM ${sql.identifier(table)}
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})
        ORDER BY id FOR UPDATE
      `);
    }
    for (const table of deletionOrder)
      for (const [id, canonical] of target[table]) {
        const guard =
          table === 'Market'
            ? sql`
        NOT EXISTS (SELECT 1 FROM "Question" WHERE "marketId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "BalanceTransaction" WHERE "relatedId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "NPCTrade" WHERE "marketId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "Position" WHERE "marketId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "PoolPosition" WHERE "marketId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "PredictionPriceHistory" WHERE "marketId" = ${id})
      `
            : table === 'User'
              ? sql`
        NOT EXISTS (SELECT 1 FROM "GameOnboarding" WHERE "userId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "UserPnLSnapshot" WHERE "userId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "Whitelist" WHERE "userId" = ${id} OR "grantedBy" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "AdminRole" WHERE "userId" = ${id} OR "grantedBy" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "BalanceTransaction" WHERE "userId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "NPCTrade" WHERE "npcActorId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "Position" WHERE "userId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "Follow" WHERE "followerId" = ${id} OR "followingId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "Post" WHERE "authorId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "ChatParticipant" WHERE "userId" = ${id})
      `
              : table === 'Question'
                ? sql`
        NOT EXISTS (SELECT 1 FROM "QuestionArcPlan" WHERE "questionId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "ArcState" WHERE "questionId" = ${id})
        AND NOT EXISTS (SELECT 1 FROM "TimeframedMarket" WHERE "questionId" = ${id})
      `
                : sql`true`;
        const removed = await tx.execute<StoredRow>(sql`
        DELETE FROM ${sql.identifier(table)} t
        WHERE id = ${id} AND to_jsonb(t) = ${canonical}::text::jsonb AND (${guard})
        RETURNING id,to_jsonb(t)::text AS canonical
      `);
        if (removed.length !== 1 || removed[0]?.canonical !== canonical)
          throw new Error(`Owned ${table}/${id} cleanup refused`);
      }
  });
  // Retain every receipt on transaction failure; never adopt changed rows.
  for (const rows of Object.values(target)) rows.clear();
}
async function expectRetained(target: Ownership) {
  for (const table of deletionOrder)
    for (const [id, canonical] of target[table]) {
      const rows = await dbWrite.execute<StoredRow>(sql`
      SELECT id,to_jsonb(t)::text AS canonical FROM ${sql.identifier(table)} t WHERE id = ${id}
    `);
      expect(Array.from(rows)).toEqual([{ id, canonical }]);
    }
}
async function fresh() {
  const id = await generateSnowflakeId();
  if (!isValidSnowflakeId(id)) throw new Error('Invalid generated fixture ID');
  return id;
}
function market(id: string): typeof markets.$inferInsert {
  const now = new Date();
  return {
    id,
    question: 'F37 owned trade-history fixture?',
    liquidity: '1000',
    endDate: new Date(now.getTime() + 86_400_000),
    updatedAt: now,
  };
}

let marketId: string, otherMarketId: string, userId: string, npcId: string;
const SAME_MS_BALANCE = 150,
  SAME_MS_NPC = 150;
const T = new Date('2026-01-15T12:00:00.000Z');
const sameMsIds: string[] = [],
  orderedIds: string[] = [],
  otherMarketIds: string[] = [];
const ip = crypto.getRandomValues(new Uint8Array(2));
const headers = { 'x-forwarded-for': `198.19.${ip[0]}.${ip[1]}` };
let requestCount = 0;
const pageSchema = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['balance', 'npc']),
      timestamp: z.string(),
    })
  ),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  marketId: z.string(),
});
async function fetchPage(offset: number, limit = 20) {
  if (++requestCount > 20)
    throw new Error('Fixture public request budget exceeded');
  const response = await fetch(
    `${base}/api/markets/predictions/${marketId}/trades?limit=${limit}&offset=${offset}`,
    {
      headers,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    }
  );
  expect(response.status).toBe(200);
  const page = pageSchema.parse(await response.json());
  expect(page.marketId).toBe(marketId);
  expect(page.trades.length).toBeLessThanOrEqual(limit);
  return page;
}
beforeAll(async () => {
  requireServer(await waitForServerAvailability(base, 10), base);
  const identity = z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        port: z.coerce.number(),
        primary: z.boolean(),
      })
    )
    .parse(
      Array.from(
        await dbWrite.execute(sql`
      SELECT current_database() AS name,current_user AS role,
        inet_server_port() AS port,NOT pg_is_in_recovery() AS primary
    `)
      )
    )[0];
  if (
    !identity ||
    identity.name !== database.pathname.slice(1) ||
    identity.role !== database.username ||
    identity.port !== Number(databasePort) ||
    !identity.primary
  )
    throw new Error('Disposable database identity mismatch');
  marketId = await fresh();
  otherMarketId = await fresh();
  userId = await fresh();
  npcId = await fresh();
  await insertUsers([
    {
      id: userId,
      username: `f37u-${userId}`,
      displayName: 'F37 Trades User',
      updatedAt: new Date(),
    },
    {
      id: npcId,
      username: `f37n-${npcId}`,
      displayName: 'F37 Trades NPC',
      isActor: true,
      updatedAt: new Date(),
    },
  ]);
  await insertMarkets([market(marketId), market(otherMarketId)]);
  const balRows: Array<typeof balanceTransactions.$inferInsert> = [];
  const npcRows: Array<typeof npcTrades.$inferInsert> = [];
  // Interleave global IDs across the two sources, all at the same millisecond.
  for (let i = 0; i < SAME_MS_BALANCE; i++) {
    balRows.push({
      id: await fresh(),
      userId,
      type: 'pred_buy',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '90.00',
      relatedId: marketId,
      createdAt: T,
    });
    npcRows.push({
      id: await fresh(),
      npcActorId: npcId,
      marketType: 'prediction',
      marketId,
      action: 'buy_yes',
      side: 'yes',
      amount: 10,
      price: 0.5,
      executedAt: T,
    });
  }
  await insertBalance(balRows);
  await insertNpc(npcRows);
  sameMsIds.push(...owned.BalanceTransaction.keys(), ...owned.NPCTrade.keys());
  for (let i = 0; i < 3; i++) {
    const id = await fresh();
    await insertBalance([
      {
        id,
        userId,
        type: 'pred_sell',
        amount: '5.00',
        balanceBefore: '90.00',
        balanceAfter: '95.00',
        relatedId: marketId,
        createdAt: new Date(T.getTime() + (i + 1) * 60_000),
      },
    ]);
    orderedIds.push(id);
  }
  for (let i = 0; i < 5; i++) {
    const id = await fresh();
    await insertBalance([
      {
        id,
        userId,
        type: 'pred_buy',
        amount: '1.00',
        balanceBefore: '95.00',
        balanceAfter: '94.00',
        relatedId: otherMarketId,
        createdAt: T,
      },
    ]);
    otherMarketIds.push(id);
  }
});
afterAll(async () => {
  await cleanup();
});

describe('prediction market trades pagination', () => {
  it('reaches every same-millisecond trade exactly once across offset pages', async () => {
    const expectedTotal = SAME_MS_BALANCE + SAME_MS_NPC + orderedIds.length;
    const seen: string[] = [],
      types = new Set<string>();
    let offset = 0,
      terminal = false;
    for (let pages = 0; pages < Math.ceil(expectedTotal / 20) + 1; pages++) {
      const page = await fetchPage(offset);
      expect(page.total).toBe(expectedTotal);
      for (const trade of page.trades) {
        seen.push(trade.id);
        types.add(trade.type);
      }
      expect(page.hasMore).toBe(offset + page.trades.length < expectedTotal);
      offset += page.trades.length;
      if (!page.hasMore) {
        terminal = true;
        break;
      }
      expect(page.trades.length).toBe(20);
    }
    expect(terminal).toBe(true);
    expect(seen).toHaveLength(expectedTotal);
    expect(new Set(seen).size).toBe(expectedTotal);
    expect(types).toEqual(new Set(['balance', 'npc']));
    expect(seen).toEqual(
      [...orderedIds].reverse().concat([...sameMsIds].sort().reverse())
    );
    for (const id of otherMarketIds) expect(seen).not.toContain(id);
    const end = await fetchPage(expectedTotal);
    expect(end.total).toBe(expectedTotal);
    expect(end.trades).toEqual([]);
    expect(end.hasMore).toBe(false);
  });
  it('keeps newest-first order across distinct timestamps', async () => {
    const firstPage = await fetchPage(0, 10);
    expect(firstPage.trades.slice(0, 3).map((trade) => trade.id)).toEqual(
      [...orderedIds].reverse()
    );
    expect(firstPage.hasMore).toBe(true);
  });
  it('retains unacquired rows and atomically refuses foreign references or changed fixtures', async () => {
    const partial = ownership(),
      failed = ownership(),
      foreign = ownership();
    let changed: StoredRow | undefined, original: StoredRow | undefined;
    try {
      const subjectUser = await fresh(),
        subjectMarket = await fresh();
      await insertUsers([{ id: subjectUser, updatedAt: new Date() }], partial);
      const neverAcquired = await fresh();
      await expect(
        insertUsers(
          [
            { id: userId, updatedAt: new Date() },
            { id: neverAcquired, updatedAt: new Date() },
          ],
          failed
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(failed.User.size).toBe(0);
      await cleanup(failed);
      await expectRetained(owned);
      expect(
        Array.from(
          await dbWrite.execute(
            sql`SELECT id FROM "User" WHERE id = ${neverAcquired}`
          )
        )
      ).toEqual([]);
      await insertMarkets([market(subjectMarket)], partial);
      await insertBalance(
        [
          {
            id: await fresh(),
            userId: subjectUser,
            type: 'pred_buy',
            amount: '10.00',
            balanceBefore: '100.00',
            balanceAfter: '90.00',
            relatedId: subjectMarket,
            createdAt: T,
          },
        ],
        partial
      );
      const questionRows = await dbWrite
        .insert(questions)
        .values({
          id: await fresh(),
          questionNumber:
            crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000,
          marketId: subjectMarket,
          text: 'F37 independently acquired foreign reference',
          scenarioId: 1,
          outcome: false,
          rank: 1,
          resolutionDate: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        })
        .returning({
          id: questions.id,
          canonical: sql<string>`to_jsonb(${questions})::text`,
        });
      acquire(foreign.Question, questionRows, 1);
      await expect(cleanup(partial)).rejects.toThrow('cleanup refused');
      await expectRetained(partial);
      await expectRetained(foreign);
      await cleanup(foreign);
      const canonical = partial.Market.get(subjectMarket);
      if (!canonical) throw new Error('Missing acquired market');
      original = { id: subjectMarket, canonical };
      const changedRows = await dbWrite.execute<StoredRow>(sql`
        UPDATE "Market" t SET question = 'F37 changed owned tuple'
        WHERE id = ${subjectMarket} AND to_jsonb(t) = ${canonical}::text::jsonb
        RETURNING id,to_jsonb(t)::text AS canonical
      `);
      changed = changedRows[0];
      if (!changed) throw new Error('Owned drift control did not update');
      await expect(cleanup(partial)).rejects.toThrow('cleanup refused');
      expect(partial.Market.get(subjectMarket)).toBe(original.canonical);
      await expectRetained({
        ...ownership(),
        Market: new Map([[changed.id, changed.canonical]]),
        User: partial.User,
        BalanceTransaction: partial.BalanceTransaction,
      });
    } finally {
      // Restore only this control's exact known changed tuple; never adopt it
      // for deletion or overwrite a concurrent/unknown change.
      if (changed && original) {
        const restored = await dbWrite.execute<StoredRow>(sql`
          UPDATE "Market" t SET question = (${original.canonical}::text::jsonb ->> 'question')
          WHERE id = ${changed.id} AND to_jsonb(t) = ${changed.canonical}::text::jsonb
          RETURNING id,to_jsonb(t)::text AS canonical
        `);
        expect(Array.from(restored)).toEqual([original]);
      }
      await cleanup(foreign);
      await cleanup(partial);
      await cleanup(failed);
    }
  });
});
