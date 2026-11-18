// Real public route and DB queries; only the server-only import marker is stubbed.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DATABASE_POOL_MAX, '1');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');
assert.equal(process.env.DISABLE_RATE_LIMITING, 'false');
const schema = process.argv[2];
assert.ok(schema && /^f36_[a-f0-9]{32}$/.test(schema));
mock.module('server-only', () => ({}));
const {
  balanceTransactions,
  closeDatabase,
  db,
  eq,
  inArray,
  npcTrades,
  organizationState,
  perpPositions,
  sql,
  users,
} = await import('@feed/db');
const {
  invalidateCachePattern,
  isRedisAvailable,
  RATE_LIMIT_CONFIGS,
  resetRateLimit,
} = await import('@feed/api');
const { NextRequest } = await import('next/server');
const { GET } = await import(
  '../../../../apps/web/src/app/api/markets/perps/trades/[ticker]/route'
);
assert.equal(isRedisAvailable(), false);
// A single owned connection keeps all repository, raw SQL and route reads in
// this fresh schema. The parent alone owns its creation and removal.
await db.execute(sql.raw(`SET search_path TO "${schema}"`));
const current = await db.execute(sql`SELECT current_schema() AS schema`);
assert.equal(current[0]?.schema, schema);
assert.equal(
  (await db.select({ id: organizationState.id }).from(organizationState))
    .length,
  0
);

type Owned = {
  users: string[];
  organizations: string[];
  positions: string[];
  transactions: string[];
  npcs: string[];
};
const ownership = (): Owned => ({
  users: [],
  organizations: [],
  positions: [],
  transactions: [],
  npcs: [],
});
const owned = ownership();
const run = randomUUID();
const TICKER = 'AMZN';
const ORG_ID = 'aimazon';
const TIE_TIME = new Date('2026-01-15T12:00:00Z');
const userIds = [`f36-${run}-user-a`, `f36-${run}-user-b`];
const positionIds = Array.from(
  { length: 120 },
  (_, i) => `f36-${run}-pos-${String(i).padStart(3, '0')}`
);
const balanceTxIds = Array.from(
  { length: 120 },
  (_, i) => `f36-${run}-btx-${String(i).padStart(3, '0')}`
);
const npcIds = Array.from(
  { length: 60 },
  (_, i) => `f36-${run}-npc-${String(i).padStart(3, '0')}`
);
const expected = new Map<string, number>();
const clientIp = `2001:db8:${run.slice(0, 4)}:${run.slice(4, 8)}::f36`;
const now = new Date();
let cases = 0;
function passed(name: string) {
  cases++;
  console.log(`F36_CASE_OK ${name}`);
}
function at<T>(rows: T[], index: number): T {
  const value = rows[index];
  assert.ok(value !== undefined);
  return value;
}
async function acquireUsers(
  values: (typeof users.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  scope.users.push(...rows.map((row) => row.id));
}
async function acquireOrg(id: string, scope = owned) {
  const rows = await db
    .insert(organizationState)
    .values({ id, currentPrice: 185, updatedAt: now })
    .returning({ id: organizationState.id });
  scope.organizations.push(...rows.map((row) => row.id));
}
async function acquirePositions(
  values: (typeof perpPositions.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(perpPositions)
    .values(values)
    .returning({ id: perpPositions.id });
  scope.positions.push(...rows.map((row) => row.id));
}
async function acquireTransactions(
  values: (typeof balanceTransactions.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(balanceTransactions)
    .values(values)
    .returning({ id: balanceTransactions.id });
  scope.transactions.push(...rows.map((row) => row.id));
}
async function acquireNpcs(
  values: (typeof npcTrades.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(npcTrades)
    .values(values)
    .returning({ id: npcTrades.id });
  scope.npcs.push(...rows.map((row) => row.id));
}
async function cleanup(scope: Owned) {
  if (scope.transactions.length) {
    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.id, scope.transactions));
    assert.deepEqual(
      await db
        .select({ id: balanceTransactions.id })
        .from(balanceTransactions)
        .where(inArray(balanceTransactions.id, scope.transactions)),
      []
    );
  }
  if (scope.npcs.length) {
    await db.delete(npcTrades).where(inArray(npcTrades.id, scope.npcs));
    assert.deepEqual(
      await db
        .select({ id: npcTrades.id })
        .from(npcTrades)
        .where(inArray(npcTrades.id, scope.npcs)),
      []
    );
  }
  if (scope.positions.length) {
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.id, scope.positions));
    assert.deepEqual(
      await db
        .select({ id: perpPositions.id })
        .from(perpPositions)
        .where(inArray(perpPositions.id, scope.positions)),
      []
    );
  }
  if (scope.organizations.length) {
    await db
      .delete(organizationState)
      .where(inArray(organizationState.id, scope.organizations));
    assert.deepEqual(
      await db
        .select({ id: organizationState.id })
        .from(organizationState)
        .where(inArray(organizationState.id, scope.organizations)),
      []
    );
  }
  if (scope.users.length) {
    await db.delete(users).where(inArray(users.id, scope.users));
    assert.deepEqual(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, scope.users)),
      []
    );
  }
}
function code(error: Error): string | undefined {
  if ('code' in error && typeof error.code === 'string') return error.code;
  return error.cause instanceof Error ? code(error.cause) : undefined;
}
async function collision(action: () => Promise<void>) {
  let actual: string | undefined;
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    actual = code(error);
  }
  assert.equal(actual, '23505');
}
async function page(limit: number, offset: number) {
  const response = await GET(
    new NextRequest(
      `http://localhost/api/markets/perps/trades/${TICKER}?limit=${limit}&offset=${offset}`,
      { headers: { 'x-forwarded-for': clientIp } }
    ),
    { params: Promise.resolve({ ticker: TICKER }) }
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('X-RateLimit-Limit'),
    String(RATE_LIMIT_CONFIGS.PUBLIC_READ.maxRequests)
  );
  assert.ok(
    Number(response.headers.get('X-RateLimit-Remaining')) <
      RATE_LIMIT_CONFIGS.PUBLIC_READ.maxRequests
  );
  const bodySchema = z.object({
    trades: z.array(z.object({ id: z.string() })),
    total: z.number(),
    hasMore: z.boolean(),
  });
  const body = z
    .union([z.object({ data: bodySchema }), bodySchema])
    .parse(await response.json());
  const data = 'data' in body ? body.data : body;
  return {
    ids: data.trades.map((row) => row.id),
    total: data.total,
    hasMore: data.hasMore,
  };
}
async function walk(limit: number) {
  const order = [...expected.keys()].sort(
    (a, b) =>
      (expected.get(b) ?? 0) - (expected.get(a) ?? 0) ||
      (a < b ? 1 : a > b ? -1 : 0)
  );
  const seen: string[] = [];
  for (let offset = 0; offset <= order.length; offset += limit) {
    const data = await page(limit, offset);
    assert.equal(data.total, order.length);
    assert.deepEqual(data.ids, order.slice(offset, offset + limit));
    assert.equal(data.hasMore, offset + data.ids.length < order.length);
    seen.push(...data.ids);
  }
  const tail = await page(limit, order.length);
  assert.deepEqual(tail.ids, []);
  assert.equal(tail.hasMore, false);
  assert.deepEqual(seen, order);
}
const positionValues = positionIds.map((id, i) => ({
  id,
  userId: at(userIds, i % 2),
  ticker: TICKER,
  organizationId: ORG_ID,
  side: i % 2 === 0 ? 'long' : 'short',
  entryPrice: 100,
  currentPrice: 101,
  size: 25,
  leverage: 2,
  liquidationPrice: 50,
  unrealizedPnL: 3.5,
  unrealizedPnLPercent: 1.4,
  openedAt: TIE_TIME,
  lastUpdated: TIE_TIME,
}));
const transactionValues = balanceTxIds.map((id, i) => ({
  id,
  userId: at(userIds, i % 2),
  type: 'perp_open',
  amount: '25.00',
  balanceBefore: '1000.00',
  balanceAfter: '975.00',
  relatedId: at(positionIds, i),
  description: 'Owned perp fixture',
  createdAt: TIE_TIME,
}));
const npcValues = npcIds.map((id) => ({
  id,
  npcActorId: 'ailon-musk',
  marketType: 'perp',
  ticker: TICKER,
  action: 'open_long',
  side: 'long',
  amount: 10,
  price: 100,
  sentiment: 0.5,
  reason: 'Owned perp fixture',
  executedAt: TIE_TIME,
}));
try {
  await acquireUsers(
    userIds.map((id) => ({ id, username: id, updatedAt: now }))
  );
  await acquireOrg(ORG_ID);
  assert.deepEqual(await page(25, 0), { ids: [], total: 0, hasMore: false });
  await invalidateCachePattern('perp-trades:amzn:*', {
    namespace: 'market-trades',
  });
  passed('empty-history-public-route');

  await acquirePositions(positionValues);
  await acquireTransactions(transactionValues);
  await acquireNpcs(npcValues);
  for (const id of [...positionIds, ...balanceTxIds, ...npcIds])
    expected.set(id, TIE_TIME.getTime());
  await walk(25);
  await walk(40);
  const cold = await page(25, 0);
  const warm = await page(25, 0);
  assert.deepEqual(warm, cold);
  passed('300-tied-rows-exact-raw-pages-and-warm-cache');

  const position = at(positionIds, 0),
    npc = at(npcIds, 0),
    transaction = at(balanceTxIds, 0);
  await db
    .update(perpPositions)
    .set({ openedAt: new Date(TIE_TIME.getTime() - 1000) })
    .where(eq(perpPositions.id, position));
  expected.set(position, TIE_TIME.getTime() - 1000);
  await db
    .update(npcTrades)
    .set({ executedAt: new Date(TIE_TIME.getTime() + 1000) })
    .where(eq(npcTrades.id, npc));
  expected.set(npc, TIE_TIME.getTime() + 1000);
  await db
    .update(balanceTransactions)
    .set({ createdAt: new Date(TIE_TIME.getTime() + 2000) })
    .where(eq(balanceTransactions.id, transaction));
  expected.set(transaction, TIE_TIME.getTime() + 2000);
  await invalidateCachePattern('perp-trades:amzn:*', {
    namespace: 'market-trades',
  });
  await walk(40);
  passed('mixed-timestamps-and-empty-tail');

  const partial = ownership();
  try {
    await acquireUsers(
      [
        {
          id: `f36-${run}-partial`,
          username: `f36-${run}-partial`,
          updatedAt: now,
        },
      ],
      partial
    );
    await collision(() => acquireOrg(ORG_ID, partial));
    await collision(() =>
      acquireUsers([{ id: at(userIds, 0), updatedAt: now }], partial)
    );
    await collision(() => acquirePositions([at(positionValues, 0)], partial));
    await collision(() =>
      acquireTransactions([at(transactionValues, 0)], partial)
    );
    await collision(() => acquireNpcs([at(npcValues, 0)], partial));
    assert.equal(
      partial.organizations.length +
        partial.positions.length +
        partial.transactions.length +
        partial.npcs.length,
      0
    );
    await cleanup(partial);
    assert.equal(
      (
        await db
          .select()
          .from(organizationState)
          .where(eq(organizationState.id, ORG_ID))
      )[0]?.currentPrice,
      185
    );
    assert.equal(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, userIds))
      ).length,
      2
    );
    assert.equal(
      (await db.select({ id: perpPositions.id }).from(perpPositions)).length,
      120
    );
    assert.equal(
      (
        await db
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
      ).length,
      120
    );
    assert.equal(
      (await db.select({ id: npcTrades.id }).from(npcTrades)).length,
      60
    );
  } finally {
    await cleanup(partial);
  }
  passed('canonical-org-and-other-rows-survive-collisions-partial-setup');
} finally {
  try {
    await cleanup(owned);
    await invalidateCachePattern('perp-trades:amzn:*', {
      namespace: 'market-trades',
    });
    await resetRateLimit(clientIp, 'public_read');
  } finally {
    await closeDatabase();
  }
}
console.log(`F36_OK cases=${cases}`);

// All owned DB writes and cleanup have completed; stop private background timers.
process.exit(0);
