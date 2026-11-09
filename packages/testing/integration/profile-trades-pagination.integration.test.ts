/** PRD §§6.1/9.2–9.3, MVP5/6: bounded, eligible public trade-history pages. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  npcTrades,
  perpPositions,
  sql,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

// Standalone execution must never inherit a remote or replica database.
function ownedDatabaseUrl(value: string | undefined) {
  if (!value || !URL.canParse(value))
    throw new Error('Owned local test database required');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/(test_db|feed_pr\d+)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Owned local test database required');
  return url;
}
const primaryDatabase = ownedDatabaseUrl(process.env.DATABASE_URL);
if (process.env.DIRECT_DATABASE_URL) {
  const direct = ownedDatabaseUrl(process.env.DIRECT_DATABASE_URL);
  if (
    direct.hostname !== primaryDatabase.hostname ||
    direct.port !== primaryDatabase.port ||
    direct.pathname !== primaryDatabase.pathname
  )
    throw new Error('Direct test database must match the primary endpoint');
}
if (process.env.DATABASE_READ_REPLICA_URL)
  throw new Error('Replica refused for owned fixture writes');

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const target = new URL(base);
if (
  target.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
)
  throw new Error('Owned loopback HTTP server required');
const owned = {
  users: new Set<string>(),
  balance: new Set<string>(),
  perps: new Set<string>(),
  npcs: new Set<string>(),
  markets: new Set<string>(),
};
const identities = new Map<string, string>(),
  tokens = new Map<string, string>();
const eligible: Array<{
  id: string;
  kind: 'balance' | 'npc' | 'perp';
  timestamp: number;
}> = [];
let runId = '',
  ip = '',
  marketId = '',
  actorId = '',
  actorAlias = '',
  orgId = '';
let baselineTotal = 0;
const profileBalanceIds: string[] = [],
  profilePerpIds: string[] = [],
  excludedIds: string[] = [];
const labels = new Map<string, string>();
const tradeSchema = z
  .object({
    id: z.string(),
    type: z.enum(['balance', 'npc', 'perp']),
    timestamp: z.string(),
    user: z.object({ id: z.string(), isActor: z.boolean() }).passthrough(),
  })
  .passthrough();
const bodySchema = z.object({
  trades: z.array(tradeSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
function lookup(map: Map<string, string>, key: string) {
  const value = map.get(key);
  if (!value) throw new Error('Missing owned fixture ' + key);
  return value;
}
const user = (key: string) => lookup(identities, key);
function auth(viewer?: string, cookie = false): Record<string, string> {
  if (!viewer) return {};
  const token = lookup(tokens, viewer);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}
async function request(query = '', viewer?: string, cookie = false) {
  return fetch(`${base}/api/trades${query ? '?' + query : ''}`, {
    headers: { 'x-forwarded-for': ip, ...auth(viewer, cookie) },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function page(query = '', viewer?: string, cookie = false) {
  const response = await request(query, viewer, cookie);
  expect(response.status).toBe(200);
  return bodySchema.parse(await response.json());
}
async function insertUsers(
  rows: Array<typeof users.$inferInsert>,
  receipts = owned.users
) {
  for (const row of await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id }))
    receipts.add(row.id);
}
async function insertBalance(
  rows: Array<typeof balanceTransactions.$inferInsert>,
  receipts = owned.balance
) {
  for (const row of await db
    .insert(balanceTransactions)
    .values(rows)
    .returning({ id: balanceTransactions.id }))
    receipts.add(row.id);
}
async function insertPerps(rows: Array<typeof perpPositions.$inferInsert>) {
  for (const row of await db
    .insert(perpPositions)
    .values(rows)
    .returning({ id: perpPositions.id }))
    owned.perps.add(row.id);
}
async function insertNpcs(rows: Array<typeof npcTrades.$inferInsert>) {
  for (const row of await db
    .insert(npcTrades)
    .values(rows)
    .returning({ id: npcTrades.id }))
    owned.npcs.add(row.id);
}
function expectedOrder(rows = eligible) {
  return [...rows].sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      a.kind.localeCompare(b.kind) ||
      b.id.localeCompare(a.id)
  );
}
function tuple(rows: Array<{ id: string; type: string }>) {
  return rows.map((row) => `${row.type}:${row.id}`);
}
function query(profile: string, limit: number, offset: number) {
  return new URLSearchParams({
    userId: profile,
    limit: String(limit),
    offset: String(offset),
  }).toString();
}

beforeAll(async () => {
  runId = await generateSnowflakeId();
  const hex = BigInt(runId).toString(16).padStart(16, '0');
  ip = `2001:db8:1693:0:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}`;
  baselineTotal = (await page('limit=1')).total;
  const latest = await db.execute<{ value: string | null }>(sql`
    SELECT greatest(
      (SELECT max("createdAt") FROM "BalanceTransaction"),
      (SELECT max("executedAt") FROM "NPCTrade"),
      (SELECT max("openedAt") FROM "PerpPosition")
    )::text AS value
  `);
  const value = latest[0]?.value;
  const time =
    Math.max(
      Date.now(),
      value ? new Date(value.replace(' ', 'T') + 'Z').getTime() : 0
    ) + 86400000;
  const now = new Date(time);
  const actors = StaticDataRegistry.getAllActors();
  const actor = actors.find(
    (row) =>
      row.username &&
      row.username.toUpperCase() !== row.id &&
      StaticDataRegistry.getActor(row.username.toUpperCase())?.id === row.id
  );
  if (!actor?.username)
    throw new Error('Registered actor with username required');
  actorId = actor.id;
  actorAlias = actor.username.toUpperCase();
  const organization = StaticDataRegistry.getAllOrganizations()[0];
  if (!organization) throw new Error('Registered organization required');
  orgId = organization.id;
  const userRows: Array<typeof users.$inferInsert> = [];
  for (const label of ['trader', 'other', 'actor', 'collision']) {
    const id = await generateSnowflakeId();
    identities.set(label, id);
    userRows.push({
      id,
      username: `p1693_${label}_${runId}`,
      displayName: 'Owned trades ' + label,
      stewardId: `p1693-${id}`,
      isActor: label === 'actor',
      updatedAt: now,
    });
  }
  await insertUsers(userRows);
  for (const label of ['trader', 'other'])
    tokens.set(label, await createStewardTestToken(`p1693-${user(label)}`));
  const proposedMarket = await generateSnowflakeId();
  for (const row of await db
    .insert(markets)
    .values({
      id: proposedMarket,
      question: 'Owned profile trade metadata',
      liquidity: '1000',
      yesShares: '1000',
      noShares: '1000',
      resolved: false,
      endDate: new Date(time + 86400000),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: markets.id })) {
    owned.markets.add(row.id);
    marketId = row.id;
  }
  const balanceRows: Array<typeof balanceTransactions.$inferInsert> = [];
  const perpRows: Array<typeof perpPositions.$inferInsert> = [];
  const npcRows: Array<typeof npcTrades.$inferInsert> = [];
  function balance(
    id: string,
    owner: string,
    timestamp: number,
    type = 'pred_buy'
  ) {
    return {
      id,
      userId: owner,
      type,
      amount: '10',
      balanceBefore: '100',
      balanceAfter: '90',
      description: 'Owned ' + runId,
      relatedId: null,
      createdAt: new Date(timestamp),
    };
  }
  function perp(id: string, owner: string, timestamp: number) {
    return {
      id,
      userId: owner,
      ticker: 'OWN',
      organizationId: 'missing-' + runId,
      side: 'long',
      entryPrice: 100,
      currentPrice: 101,
      size: 10,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 5,
      unrealizedPnLPercent: 5,
      fundingPaid: 0,
      openedAt: new Date(timestamp),
      lastUpdated: now,
      closedAt: new Date(timestamp + 1),
    };
  }
  function npc(id: string, owner: string, timestamp: number) {
    return {
      id,
      npcActorId: owner,
      marketType: 'prediction',
      marketId,
      action: 'buy',
      side: 'YES',
      amount: 10,
      price: 0.5,
      sentiment: 0.2,
      reason: 'Owned ' + runId,
      executedAt: new Date(timestamp),
    };
  }
  for (let index = 0; index < 25; index++) {
    const bid = await generateSnowflakeId(),
      pid = await generateSnowflakeId();
    profileBalanceIds.push(bid);
    profilePerpIds.push(pid);
    balanceRows.push({
      ...balance(
        bid,
        user('trader'),
        time - index * 1000,
        index % 2 ? 'pred_sell' : 'pred_buy'
      ),
      relatedId: index === 0 ? marketId : 'missing-' + runId,
    });
    perpRows.push({
      ...perp(pid, user('trader'), time - 3600000 - index * 1000),
      organizationId: index === 0 ? orgId : 'missing-' + runId,
    });
    eligible.push(
      { id: bid, kind: 'balance', timestamp: time - index * 1000 },
      { id: pid, kind: 'perp', timestamp: time - 3600000 - index * 1000 }
    );
  }
  for (let index = 0; index < 3; index++) {
    const id = await generateSnowflakeId();
    balanceRows.push(balance(id, user('other'), time + 100 - index));
    eligible.push({ id, kind: 'balance', timestamp: time + 100 - index });
  }
  for (let index = 0; index < 2; index++) {
    const id = await generateSnowflakeId();
    perpRows.push(perp(id, user('actor'), time + 175 - index));
    eligible.push({ id, kind: 'perp', timestamp: time + 175 - index });
  }
  for (const [label, owner, timestamp] of [
    ['database-actor', user('actor'), time + 200],
    ['static-actor', actorId, time + 300],
    ['actor-alias', actorAlias, time + 300],
  ] as const) {
    const id = await generateSnowflakeId();
    labels.set(label, id);
    npcRows.push(npc(id, owner, timestamp));
    eligible.push({ id, kind: 'npc', timestamp });
  }
  const collisionId = await generateSnowflakeId();
  labels.set('cross-source-id', collisionId);
  balanceRows.push(balance(collisionId, user('collision'), time + 250));
  perpRows.push(perp(collisionId, user('collision'), time + 250));
  eligible.push(
    { id: collisionId, kind: 'balance', timestamp: time + 250 },
    { id: collisionId, kind: 'perp', timestamp: time + 250 }
  );
  // Newer ineligible source prefixes must not displace older eligible rows.
  for (let index = 0; index < 10; index++) {
    for (const owner of [user('actor'), 'missing-user-' + runId]) {
      const id = await generateSnowflakeId();
      balanceRows.push(balance(id, owner, time + 3600000 + index));
      excludedIds.push(id);
    }
    const pid = await generateSnowflakeId(),
      nid = await generateSnowflakeId();
    perpRows.push(perp(pid, 'missing-user-' + runId, time + 3600000 + index));
    npcRows.push(npc(nid, 'missing-actor-' + runId, time + 3600000 + index));
    excludedIds.push(pid, nid);
  }
  const nonTradeId = await generateSnowflakeId();
  balanceRows.push(
    balance(nonTradeId, user('trader'), time + 7200000, 'deposit')
  );
  excludedIds.push(nonTradeId);
  await insertBalance(balanceRows);
  await insertPerps(perpRows);
  await insertNpcs(npcRows);
});

afterAll(async () => {
  const cleanupErrors: Error[] = [];
  for (const [name, table, ids] of [
    ['balance', balanceTransactions, owned.balance],
    ['perps', perpPositions, owned.perps],
    ['npcs', npcTrades, owned.npcs],
    ['markets', markets, owned.markets],
    ['users', users, owned.users],
  ] as const) {
    if (!ids.size) continue;
    const [result] = await Promise.allSettled([
      (async () => {
        // Table-specific operations avoid acquiring cleanup ownership from generated IDs.
        let removed: Array<{ id: string }>;
        if (name === 'balance')
          removed = await db
            .delete(balanceTransactions)
            .where(inArray(balanceTransactions.id, [...ids]))
            .returning({ id: balanceTransactions.id });
        else if (name === 'perps')
          removed = await db
            .delete(perpPositions)
            .where(inArray(perpPositions.id, [...ids]))
            .returning({ id: perpPositions.id });
        else if (name === 'npcs')
          removed = await db
            .delete(npcTrades)
            .where(inArray(npcTrades.id, [...ids]))
            .returning({ id: npcTrades.id });
        else if (name === 'markets')
          removed = await db
            .delete(markets)
            .where(inArray(markets.id, [...ids]))
            .returning({ id: markets.id });
        else
          removed = await db
            .delete(users)
            .where(inArray(users.id, [...ids]))
            .returning({ id: users.id });
        expect(removed).toHaveLength(ids.size);
        const remaining = await db
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, [...ids]));
        expect(remaining).toHaveLength(0);
      })(),
    ]);
    if (result?.status === 'rejected')
      cleanupErrors.push(
        result.reason instanceof Error
          ? result.reason
          : new Error('Owned fixture cleanup failed')
      );
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      'Owned trade fixture cleanup failed'
    );
});

describe('actual HTTP eligible merged trade pages', () => {
  it('reports full mixed-source profile totals and reaches every retained historical trade', async () => {
    const seen: string[] = [],
      sizes: number[] = [];
    for (const offset of [0, 20, 40]) {
      const body = await page(query(user('trader'), 20, offset), 'trader');
      expect(body.total).toBe(50);
      expect(body.hasMore).toBe(offset < 40);
      sizes.push(body.trades.length);
      seen.push(...body.trades.map((row) => row.id));
    }
    expect(sizes).toEqual([20, 20, 10]);
    expect(seen).toEqual([...profileBalanceIds, ...profilePerpIds]);
    expect(new Set(seen).size).toBe(50);
  });
  it('fills small global pages after excluded source prefixes and counts only eligible rows', async () => {
    const body = await page('limit=5');
    expect(body.trades).toHaveLength(5);
    expect(body.total).toBe(baselineTotal + eligible.length);
    expect(tuple(body.trades)).toEqual(
      expectedOrder()
        .slice(0, 5)
        .map((row) => `${row.kind}:${row.id}`)
    );
    expect(body.trades.every((row) => !excludedIds.includes(row.id))).toBe(
      true
    );
  });
  it('walks the complete owned global prefix in deterministic merged order', async () => {
    const seen: Array<z.infer<typeof tradeSchema>> = [];
    for (let offset = 0; offset < eligible.length; offset += 15) {
      const body = await page(`limit=15&offset=${offset}`);
      expect(body.total).toBe(baselineTotal + eligible.length);
      seen.push(...body.trades);
    }
    expect(tuple(seen.slice(0, eligible.length))).toEqual(
      expectedOrder().map((row) => `${row.kind}:${row.id}`)
    );
    expect(new Set(tuple(seen.slice(0, eligible.length))).size).toBe(
      eligible.length
    );
  });
  it('preserves public user filtering independently of the signed viewer', async () => {
    const anon = await page(query(user('other'), 20, 0)),
      bearer = await page(query(user('other'), 20, 0), 'trader'),
      cookie = await page(query(user('other'), 20, 0), 'other', true);
    expect(anon.total).toBe(3);
    expect(anon.hasMore).toBe(false);
    expect(tuple(anon.trades)).toEqual(tuple(bearer.trades));
    expect(tuple(cookie.trades)).toEqual(tuple(anon.trades));
    expect(anon.trades.every((row) => row.user.id === user('other'))).toBe(
      true
    );
  });
  it('retains database actors globally but does not broaden their profile NPC source', async () => {
    const body = await page(query(user('actor'), 20, 0));
    expect(body.total).toBe(2);
    expect(
      body.trades.every((row) => row.type === 'perp' && row.user.isActor)
    ).toBe(true);
    const global = await page('limit=10');
    expect(
      global.trades.some((row) => row.id === lookup(labels, 'database-actor'))
    ).toBe(true);
  });
  it('preserves static actor IDs and case-insensitive username fallback with exact history keys', async () => {
    for (const [key, label] of [
      [actorId, 'static-actor'],
      [actorAlias, 'actor-alias'],
    ] as const) {
      const body = await page(query(key, 100, 0));
      expect(body.trades.some((row) => row.id === lookup(labels, label))).toBe(
        true
      );
      expect(body.trades.every((row) => row.user.isActor)).toBe(true);
    }
    const alias = await page(query(actorAlias, 100, 0));
    expect(alias.total).toBe(1);
    expect(alias.trades[0]?.user.id).toBe(actorId);
  });
  it('uses source-qualified tie ordering without changing outward trade IDs', async () => {
    const first = await page(query(user('collision'), 1, 0)),
      second = await page(query(user('collision'), 1, 1));
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(tuple([...first.trades, ...second.trades])).toEqual([
      `balance:${lookup(labels, 'cross-source-id')}`,
      `perp:${lookup(labels, 'cross-source-id')}`,
    ]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
  });
  it('preserves market, organization, missing-display and scalar payload values', async () => {
    const first = await page(query(user('trader'), 2, 0));
    const visible = first.trades[0];
    expect(visible?.type).toBe('balance');
    expect(visible?.amount).toBe('10.00');
    expect(visible?.transactionType).toBe('pred_buy');
    expect(visible?.market).toMatchObject({
      id: marketId,
      question: 'Owned profile trade metadata',
      resolved: false,
    });
    expect(first.trades[1]?.market).toBeNull();
    const positions = await page(query(user('trader'), 2, 25));
    expect(positions.trades[0]?.organization).toMatchObject({
      id: orgId,
      ticker: 'OWN',
    });
    expect(positions.trades[1]?.organization).toBeNull();
    expect(positions.trades[0]?.closedAt).toBeString();
  });
  it('reports truthful empty, tail and deep out-of-range pages', async () => {
    const tail = await page(query(user('trader'), 20, 49)),
      beyond = await page(query(user('trader'), 20, 1000000)),
      empty = await page(query('absent-' + runId, 20, 0));
    expect(tail.trades).toHaveLength(1);
    expect(tail.total).toBe(50);
    expect(tail.hasMore).toBe(false);
    expect(beyond.trades).toHaveLength(0);
    expect(beyond.total).toBe(50);
    expect(beyond.hasMore).toBe(false);
    expect(empty).toEqual({ trades: [], total: 0, hasMore: false });
  });
  it('preserves default pagination, public headers and existing input refusal', async () => {
    const response = await request('userId=' + user('trader'), 'trader');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=5, stale-while-revalidate=10'
    );
    expect(Number(response.headers.get('x-ratelimit-limit'))).toBeGreaterThan(
      0
    );
    const body = bodySchema.parse(await response.json());
    expect(body.trades).toHaveLength(50);
    expect(body.total).toBe(50);
    expect(body.hasMore).toBe(false);
    for (const q of [
      'limit=0',
      'limit=101',
      'limit=bad',
      'offset=-1',
      'offset=bad',
    ])
      expect((await request(q, 'trader')).status).toBe(400);
  });
  it('orders actual stored microseconds across sources without changing timestamp responses', async () => {
    const uid = await generateSnowflakeId(),
      older = await generateSnowflakeId(),
      newer = await generateSnowflakeId(),
      middle = await generateSnowflakeId();
    await insertUsers([
      { id: uid, username: 'micro-' + runId, updatedAt: new Date() },
    ]);
    await insertBalance(
      [older, newer].map((id) => ({
        id,
        userId: uid,
        type: 'pred_buy',
        amount: '1',
        balanceBefore: '10',
        balanceAfter: '9',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }))
    );
    await insertPerps([
      {
        id: middle,
        userId: uid,
        ticker: 'OWN',
        organizationId: 'missing-' + runId,
        side: 'long',
        entryPrice: 100,
        currentPrice: 101,
        size: 1,
        leverage: 2,
        liquidationPrice: 50,
        unrealizedPnL: 1,
        unrealizedPnLPercent: 1,
        fundingPaid: 0,
        openedAt: new Date('2026-01-01T00:00:00.000Z'),
        lastUpdated: new Date(),
      },
    ]);
    const types = await db.execute<{ column: string; oid: number }>(sql`
      SELECT attname AS column, atttypid::int AS oid FROM pg_attribute
      WHERE (attrelid = '"BalanceTransaction"'::regclass AND attname = 'createdAt')
         OR (attrelid = '"PerpPosition"'::regclass AND attname = 'openedAt')
      ORDER BY attname
    `);
    expect([...types]).toEqual([
      { column: 'createdAt', oid: 1114 },
      { column: 'openedAt', oid: 1114 },
    ]);
    // Force a text parameter before the native column cast: postgres.js otherwise
    // serializes timestamp parameters through Date and can erase these digits.
    for (const [id, timestamp] of [
      [older, '2026-01-01 00:00:00.000100'],
      [newer, '2026-01-01 00:00:00.000950'],
    ] as const) {
      const stored = await db.execute<{ id: string; stored: string }>(sql`
        UPDATE "BalanceTransaction" SET "createdAt" = ${timestamp}::text::timestamp without time zone
        WHERE id = ${id} RETURNING id, to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.US') AS stored
      `);
      expect([...stored]).toEqual([{ id, stored: timestamp }]);
    }
    const timestamp = '2026-01-01 00:00:00.000500';
    const stored = await db.execute<{ id: string; stored: string }>(sql`
      UPDATE "PerpPosition" SET "openedAt" = ${timestamp}::text::timestamp without time zone
      WHERE id = ${middle} RETURNING id, to_char("openedAt", 'YYYY-MM-DD HH24:MI:SS.US') AS stored
    `);
    expect([...stored]).toEqual([{ id: middle, stored: timestamp }]);
    const seen: Array<z.infer<typeof tradeSchema>> = [];
    for (const offset of [0, 1, 2]) {
      const body = await page(query(uid, 1, offset));
      expect(body.total).toBe(3);
      expect(body.hasMore).toBe(offset < 2);
      seen.push(...body.trades);
    }
    expect(tuple(seen)).toEqual([
      `balance:${newer}`,
      `perp:${middle}`,
      `balance:${older}`,
    ]);
    expect(
      seen.every((row) => row.timestamp === '2026-01-01T00:00:00.000Z')
    ).toBe(true);
  });
  it('does not acquire cleanup ownership after failed user or balance setup', async () => {
    const controlUsers = new Set<string>(),
      controlBalance = new Set<string>(),
      attemptedUsers = new Set<string>(),
      attemptedBalance = new Set<string>();
    const uid = await generateSnowflakeId(),
      bid = await generateSnowflakeId(),
      missingUid = await generateSnowflakeId(),
      missingBid = await generateSnowflakeId();
    try {
      await insertUsers(
        [{ id: uid, username: 'collision-' + runId, updatedAt: new Date() }],
        controlUsers
      );
      await insertBalance(
        [
          {
            id: bid,
            userId: uid,
            type: 'deposit',
            amount: '1',
            balanceBefore: '0',
            balanceAfter: '1',
          },
        ],
        controlBalance
      );
      for (const insert of [
        () =>
          insertUsers(
            [
              {
                id: uid,
                username: 'duplicate-' + runId,
                updatedAt: new Date(),
              },
              {
                id: missingUid,
                username: 'never-' + runId,
                updatedAt: new Date(),
              },
            ],
            attemptedUsers
          ),
        () =>
          insertBalance(
            [
              {
                id: bid,
                userId: uid,
                type: 'deposit',
                amount: '1',
                balanceBefore: '0',
                balanceAfter: '1',
              },
              {
                id: missingBid,
                userId: uid,
                type: 'deposit',
                amount: '1',
                balanceBefore: '0',
                balanceAfter: '1',
              },
            ],
            attemptedBalance
          ),
      ]) {
        let failed = false;
        try {
          await insert();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('cause' in error) ||
            typeof error.cause !== 'object' ||
            error.cause === null ||
            !('code' in error.cause) ||
            error.cause.code !== '23505'
          )
            throw error;
          failed = true;
        }
        expect(failed).toBe(true);
      }
      expect(attemptedUsers.size).toBe(0);
      expect(attemptedBalance.size).toBe(0);
      expect(
        await db.select({ id: users.id }).from(users).where(eq(users.id, uid))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
          .where(eq(balanceTransactions.id, bid))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, missingUid))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
          .where(eq(balanceTransactions.id, missingBid))
      ).toHaveLength(0);
    } finally {
      if (controlBalance.size)
        await db
          .delete(balanceTransactions)
          .where(inArray(balanceTransactions.id, [...controlBalance]));
      if (controlUsers.size)
        await db.delete(users).where(inArray(users.id, [...controlUsers]));
      expect(
        await db.select({ id: users.id }).from(users).where(eq(users.id, uid))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
          .where(eq(balanceTransactions.id, bid))
      ).toHaveLength(0);
    }
  });
});
