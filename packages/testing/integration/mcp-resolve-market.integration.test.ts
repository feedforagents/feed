/** PRD §§8.2/9.2, MVP Phase 6: one durable admin resolution across lifecycle rows. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  adminAuditLogs,
  balanceTransactions,
  closeDatabase,
  dbWrite as db,
  eq,
  markets,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  questions,
  timeframedMarkets,
  userApiKeys,
  users,
} from '@feed/db';
import { FEE_CONFIG, withPredictionSettlement } from '@feed/engine';
import { floorPoints, generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { requireServer, waitForServerAvailability } from './helpers';
import { createStewardTestToken } from './helpers/steward-auth';

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const databaseUrl = process.env.DATABASE_URL ?? '';
const owned = {
  users: new Set<string>(),
  markets: new Set<string>(),
  questions: new Set<string>(),
  timeframed: new Set<string>(),
  keys: new Set<string>(),
};
const control = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 2,
  onnotice: () => {},
  connection: {
    statement_timeout: 2000,
    lock_timeout: 1000,
    idle_in_transaction_session_timeout: 10000,
    timezone: 'UTC',
  },
});
const keys = new Map<string, string>();
let adminId = '';
let adminToken = '';
const options = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};
const envelope = z.object({
  result: z.object({
    isError: z.boolean(),
    content: z
      .array(z.object({ type: z.literal('text'), text: z.string() }))
      .length(1),
  }),
});
const listing = z.object({
  markets: z.array(z.object({ id: z.string().optional() })),
});
const newListing = z.object({
  markets: z.array(z.object({ marketId: z.string().nullable() })),
});
async function request(path: string, init: RequestInit = {}) {
  return fetch(base + path, {
    ...init,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}
async function resolve(
  marketId: string,
  resolution: boolean,
  caller = 'admin'
) {
  const key = keys.get(caller);
  if (!key) throw new Error('Missing owned API key');
  const response = await request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: 'resolve_market',
        arguments: {
          marketId,
          resolution,
          reason: 'Owned lifecycle regression',
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  const result = envelope.parse(await response.json()).result;
  return { isError: result.isError, text: result.content[0]!.text };
}
async function acquireUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  for (const row of inserted) ownership.add(row.id);
}
async function fixture(shares = '500') {
  const id = await generateSnowflakeId();
  const end = new Date(Date.now() + 86400000);
  const inserted = await db
    .insert(markets)
    .values({
      id,
      question: 'Owned MCP lifecycle regression',
      yesShares: shares,
      noShares: shares,
      liquidity: String(Number(shares) * 2),
      endDate: end,
      updatedAt: new Date(),
    })
    .returning({ id: markets.id });
  for (const row of inserted) owned.markets.add(row.id);
  let number: number | undefined;
  for (let attempt = 0; attempt < 16 && number === undefined; attempt++) {
    const candidate =
      1000000000 +
      (crypto.getRandomValues(new Uint32Array(1))[0]! % 1000000000);
    const added = await db
      .insert(questions)
      .values({
        id,
        marketId: id,
        questionNumber: candidate,
        text: 'Owned MCP lifecycle regression',
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: end,
        status: 'active',
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: questions.questionNumber })
      .returning({ id: questions.id });
    for (const row of added) owned.questions.add(row.id);
    if (added.length) number = candidate;
  }
  if (number === undefined)
    throw new Error('Could not acquire a unique owned question number');
  const timeframedId = await generateSnowflakeId();
  const added = await db
    .insert(timeframedMarkets)
    .values({
      id: timeframedId,
      questionId: id,
      timeframe: 'daily',
      startTime: new Date(),
      endTime: end,
      arcStateEnteredAt: new Date(),
      isActive: true,
      updatedAt: new Date(),
    })
    .returning({ id: timeframedMarkets.id });
  for (const row of added) owned.timeframed.add(row.id);
  return { id, timeframedId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fund(f: Fixture) {
  const yes = await generateSnowflakeId();
  const no = await generateSnowflakeId();
  await acquireUsers(
    [yes, no].map((id) => ({
      id,
      username: `p1687_${id}`,
      virtualBalance: '1000',
      totalDeposited: '1000',
      updatedAt: new Date(),
    }))
  );
  // Real settlement service/wallet setup, without unrelated shared fee-fund mutation.
  for (const [userId, side] of [
    [yes, 'yes'],
    [no, 'no'],
  ] as const)
    await withPredictionSettlement(
      f.id,
      { userId },
      (service) => service.buy({ userId, marketId: f.id, side, amount: 10 }),
      options
    );
  return { yes, no, before: await state(f) };
}
async function state(f: Fixture) {
  return {
    market: await db.select().from(markets).where(eq(markets.id, f.id)),
    question: await db.select().from(questions).where(eq(questions.id, f.id)),
    timeframed: await db
      .select()
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.id, f.timeframedId)),
    holdings: await db
      .select()
      .from(positions)
      .where(eq(positions.marketId, f.id)),
    ledger: await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.relatedId, f.id)),
    history: await db
      .select()
      .from(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, f.id)),
    audit: await db
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.resourceId, f.id)),
  };
}
async function settled(
  f: Fixture,
  outcome: boolean,
  funding?: Awaited<ReturnType<typeof fund>>
) {
  const actual = await state(f);
  expect(actual.market[0]?.resolved).toBe(true);
  expect(actual.market[0]?.resolution).toBe(outcome);
  expect(actual.question[0]?.status).toBe('resolved');
  expect(actual.question[0]?.resolvedOutcome).toBe(outcome);
  expect(actual.question[0]?.resolutionReviewedBy).toBe(adminId);
  expect(actual.timeframed[0]?.isActive).toBe(false);
  expect(actual.timeframed[0]?.isResolved).toBe(true);
  expect(actual.timeframed[0]?.resolvedAt).toEqual(
    actual.question[0]?.resolutionReviewedAt
  );
  expect(
    actual.history.filter((row) => row.eventType === 'resolution')
  ).toHaveLength(1);
  expect(actual.audit).toHaveLength(1);
  if (funding) {
    const credits = actual.ledger.filter((row) => row.type === 'pred_resolve');
    expect(credits).toHaveLength(1);
    for (const previous of funding.before.holdings) {
      const winner = previous.side === outcome;
      const payout = winner ? floorPoints(Number(previous.shares)) : 0;
      const current = actual.holdings.find((row) => row.id === previous.id);
      expect(current?.status).toBe('resolved');
      expect(current?.outcome).toBe(winner);
      expect(Number(current?.pnl)).toBeCloseTo(
        payout - Number(previous.cashCostBasis),
        8
      );
      expect(current?.resolvedAt).toEqual(actual.timeframed[0]?.resolvedAt);
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, previous.userId));
      expect(Number(user?.virtualBalance)).toBeCloseTo(990 + payout, 8);
      const userCredits = credits.filter(
        (row) => row.userId === previous.userId
      );
      expect(userCredits).toHaveLength(winner ? 1 : 0);
      if (winner) expect(Number(userCredits[0]?.amount)).toBe(payout);
    }
  }
  return actual;
}
async function contend(f: Fixture) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const blocker = control.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'prediction-settlement:' + f.id,
    ]);
    const [row] = await tx.unsafe<{ pid: number }[]>(
      'SELECT pg_backend_pid() AS pid'
    );
    if (!row) throw new Error('Missing owned blocker PID');
    ready.resolve(row.pid);
    await release.promise;
  });
  void blocker.catch(ready.reject);
  const pending: Array<ReturnType<typeof resolve>> = [];
  let workerPids: number[] = [];
  try {
    const pid = await ready.promise;
    pending.push(resolve(f.id, true), resolve(f.id, false));
    for (const call of pending) void call.catch(() => {});
    const deadline = Date.now() + 5000;
    while (workerPids.length < 2 && Date.now() < deadline) {
      const waiting = await control<
        { pid: number }[]
      >`SELECT waiting.pid FROM pg_locks waiting JOIN pg_locks held ON held.pid=${pid} AND held.locktype='advisory' AND held.granted AND waiting.database=held.database AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid WHERE waiting.locktype='advisory' AND NOT waiting.granted`;
      workerPids = waiting.map((row) => row.pid);
      if (workerPids.length < 2) await Bun.sleep(10);
    }
    expect(workerPids).toHaveLength(2);
    release.resolve();
    await blocker;
    return await Promise.all(pending);
  } finally {
    release.resolve();
    for (const result of await Promise.allSettled([blocker, ...pending]))
      expect(result.status).toBe('fulfilled');
    if (workerPids.length) {
      const [left] = await control<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=ANY(${workerPids}) AND (wait_event='advisory' OR state='idle in transaction')`;
      expect(left?.count).toBe(0);
    }
  }
}
beforeAll(async () => {
  const url = new URL(databaseUrl);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  expect(url.pathname).toMatch(/^\/(test_db|feed_pr\d+)$/);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(base).hostname);
  requireServer(await waitForServerAvailability(base, 10), base);
  adminId = await generateSnowflakeId();
  const outsider = await generateSnowflakeId();
  await acquireUsers([
    {
      id: adminId,
      username: `p1687_${adminId}`,
      stewardId: `p1687-${adminId}`,
      isAdmin: true,
      updatedAt: new Date(),
    },
    { id: outsider, username: `p1687_${outsider}`, updatedAt: new Date() },
  ]);
  adminToken = await createStewardTestToken(`p1687-${adminId}`);
  for (const [label, userId] of [
    ['admin', adminId],
    ['outsider', outsider],
  ]) {
    const key = generateApiKey();
    const rows = await db
      .insert(userApiKeys)
      .values({
        id: await generateSnowflakeId(),
        userId: userId!,
        name: 'Owned MCP lifecycle regression',
        keyHash: hashApiKey(key),
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning({ id: userApiKeys.id });
    for (const row of rows) owned.keys.add(row.id);
    keys.set(label!, key);
  }
});
async function cleanupRows(table: string, column: string, ids: Set<string>) {
  if (!ids.size) return;
  const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const before = await control.unsafe<{ id: string }[]>(
    `SELECT id FROM ${quoted(table)} WHERE ${quoted(column)}=ANY($1::text[])`,
    [[...ids]]
  );
  const removed = await control.unsafe<{ id: string }[]>(
    `DELETE FROM ${quoted(table)} WHERE ${quoted(column)}=ANY($1::text[]) RETURNING id`,
    [[...ids]]
  );
  expect(new Set(removed.map((row) => row.id))).toEqual(
    new Set(before.map((row) => row.id))
  );
  expect(
    await control.unsafe(
      `SELECT id FROM ${quoted(table)} WHERE ${quoted(column)}=ANY($1::text[])`,
      [[...ids]]
    )
  ).toHaveLength(0);
}
afterAll(async () => {
  try {
    await cleanupRows('AdminAuditLog', 'resourceId', owned.markets);
    await cleanupRows('PredictionPriceHistory', 'marketId', owned.markets);
    for (const table of [
      'BalanceTransaction',
      'PointsTransaction',
      'Position',
      'TradingFee',
    ])
      await cleanupRows(table, 'userId', owned.users);
    await cleanupRows('TimeframedMarket', 'id', owned.timeframed);
    await cleanupRows('Question', 'id', owned.questions);
    await cleanupRows('Market', 'id', owned.markets);
    await cleanupRows('UserApiKey', 'id', owned.keys);
    await cleanupRows('User', 'id', owned.users);
  } finally {
    await Promise.all([control.end({ timeout: 2 }), closeDatabase()]);
  }
});

describe('actual keyed MCP admin resolution', () => {
  it('preserves unauthenticated and non-admin refusal', async () => {
    const f = await fixture();
    const before = await state(f);
    for (const key of ['', 'invalid-owned-key']) {
      const response = await request('/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'X-Feed-Api-Key': key } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'auth-control',
          method: 'tools/call',
          params: {
            name: 'resolve_market',
            arguments: { marketId: f.id, resolution: true },
          },
        }),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect((await resolve(f.id, true, 'outsider')).isError).toBe(true);
    expect(await state(f)).toEqual(before);
  });
  for (const outcome of [true, false])
    it(`settles funded ${outcome ? 'YES' : 'NO'} holders with coherent durable lifecycle rows`, async () => {
      const f = await fixture();
      const funding = await fund(f);
      expect((await resolve(f.id, outcome)).isError).toBe(false);
      await settled(f, outcome, funding);
    });
  it('keeps empty-market behavior and authenticated widget visibility consistent', async () => {
    // Give these empty fixtures enough existing pool volume to remain in
    // the real widget's top ten when the full suite seeds other markets.
    const f = await fixture('5000000');
    const active = await fixture('5000000');
    const response = await request('/api/feed/widgets/markets', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    expect(
      listing.parse(await response.json()).markets.map((row) => row.id)
    ).toContain(f.id);
    expect((await resolve(f.id, true)).isError).toBe(false);
    await settled(f, true);
    const after = await request('/api/feed/widgets/markets', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.status).toBe(200);
    const ids = listing.parse(await after.json()).markets.map((row) => row.id);
    expect(ids).not.toContain(f.id);
    expect(ids).toContain(active.id);
    // Preserve the existing anonymous feed cache's 60-second TTL. This
    // establishes eventual fresh-list behavior, not instant invalidation.
    const deadline = Date.now() + 65000;
    let visible: Array<string | null> = [];
    while (Date.now() < deadline) {
      const response = await request('/api/feed/new-markets');
      expect(response.status).toBe(200);
      visible = newListing
        .parse(await response.json())
        .markets.map((row) => row.marketId);
      if (visible.includes(active.id) && !visible.includes(f.id)) break;
      await Bun.sleep(1500);
    }
    expect(visible).toContain(active.id);
    expect(visible).not.toContain(f.id);
  }, 80000);
  it('rejects replay without changing settled balances or metadata', async () => {
    const f = await fixture();
    const funding = await fund(f);
    expect((await resolve(f.id, true)).isError).toBe(false);
    const before = await settled(f, true, funding);
    expect((await resolve(f.id, true)).isError).toBe(true);
    expect((await resolve(f.id, false)).isError).toBe(true);
    expect(await state(f)).toEqual(before);
    await settled(f, true, funding);
  });
  it('keeps competing resolutions coherent through the existing lock', async () => {
    const f = await fixture();
    const funding = await fund(f);
    const results = await contend(f);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    const current = await state(f);
    expect(typeof current.market[0]?.resolution).toBe('boolean');
    await settled(f, current.market[0]!.resolution!, funding);
  }, 20000);
  it('rolls settlement back if an auxiliary lifecycle update fails', async () => {
    const f = await fixture();
    const funding = await fund(f);
    const name = `p1687_${f.id}`;
    let oid: number | undefined;
    try {
      await control.unsafe(
        `ALTER TABLE "Question" ADD CONSTRAINT "${name}" CHECK (id <> '${f.id}' OR status <> 'resolved') NOT VALID`
      );
      const [row] = await control<
        { oid: number }[]
      >`SELECT oid::int AS oid FROM pg_constraint WHERE conrelid='"Question"'::regclass AND conname=${name}`;
      if (!row) throw new Error('Missing owned failure constraint');
      oid = row.oid;
      const refused = await resolve(f.id, true);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Question');
      expect(await state(f)).toEqual(funding.before);
      for (const id of [funding.yes, funding.no]) {
        const [user] = await db.select().from(users).where(eq(users.id, id));
        expect(Number(user?.virtualBalance)).toBe(990);
        expect(Number(user?.lifetimePnL)).toBe(0);
        expect(
          await db
            .select()
            .from(pointsTransactions)
            .where(eq(pointsTransactions.userId, id))
        ).toHaveLength(0);
      }
    } finally {
      if (oid !== undefined) {
        const [current] = await control<
          { oid: number }[]
        >`SELECT oid::int AS oid FROM pg_constraint WHERE conrelid='"Question"'::regclass AND conname=${name}`;
        expect(current?.oid).toBe(oid);
        await control.unsafe(
          `ALTER TABLE "Question" DROP CONSTRAINT "${name}"`
        );
      }
    }
    expect((await resolve(f.id, true)).isError).toBe(false);
    await settled(f, true, funding);
  }, 20000);
  it('does not acquire cleanup ownership after an atomic user collision', async () => {
    const fresh = await generateSnowflakeId();
    const acquired = new Set<string>();
    await expect(
      acquireUsers(
        [
          { id: fresh, updatedAt: new Date() },
          { id: adminId, updatedAt: new Date() },
        ],
        acquired
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(acquired.size).toBe(0);
    expect(
      await db.select().from(users).where(eq(users.id, fresh))
    ).toHaveLength(0);
    expect(
      (await db.select().from(users).where(eq(users.id, adminId)))[0]?.isAdmin
    ).toBe(true);
  });
  it('preserves missing-market refusal', async () => {
    const absent = await generateSnowflakeId();
    expect((await resolve(absent, true)).isError).toBe(true);
    expect(
      await db.select().from(markets).where(eq(markets.id, absent))
    ).toHaveLength(0);
  });
});
