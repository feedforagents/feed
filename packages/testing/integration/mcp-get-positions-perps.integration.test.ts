/**
 * PRD §8.2/§9.2/§9.3, MVP Phase 3/6: the existing portfolio tool includes
 * open perpetuals. Seeded snapshots prove mapping, not execution or fresh marks.
 * The final HTTP case uses normal per-user MCP keys, without an auth bypass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  and,
  dbWrite as db,
  eq,
  gameOnboarding,
  inArray,
  markets,
  perpPositions,
  positions,
  questions,
  sql,
  type Transaction,
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { executeGetPositions } from '../../mcp/src/handlers/tool-handlers';
import type { GetPositionsArgs } from '../../mcp/src/types/mcp';

const databaseURL = process.env.DATABASE_URL ?? '';
const database = new URL(databaseURL);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseURL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(BASE_URL);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback MCP server required');
for (const configured of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (configured && new URL(configured).origin !== server.origin)
    throw new Error('Fixture HTTP origins must agree');

function receipts() {
  return {
    positions: new Map<string, string>(),
    perps: new Map<string, string>(),
    keys: new Map<string, string>(),
    markets: new Map<string, string>(),
    users: new Map<string, string>(),
  };
}
const owned = receipts();
const controls = receipts();
const foreignQuestions = new Map<string, string>();
const foreignOnboarding = new Map<string, string>();
const now = new Date();
let firstKeyUse = new Date();
let agentUserId = '';
let otherUserId = '';
let emptyUserId = '';
let marketId = '';
let activePredictionId = '';
let secondPredictionId = '';
let openPerpId = '';
let shortPerpId = '';
let closedPerpId = '';
let otherPerpId = '';
const keys = new Map<string, string>();
const agent = () => ({ agentId: 'agent', userId: agentUserId });

async function newId() {
  const id = await generateSnowflakeId();
  assert.ok(isValidSnowflakeId(id));
  return id;
}
async function insertUser(tx: Transaction, target: typeof owned) {
  const id = await newId();
  const [row] = await tx
    .insert(users)
    .values({ id, username: `mcppos_${id}`, isActor: false, updatedAt: now })
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  assert.ok(row);
  target.users.set(row.id, row.canonical);
  return row.id;
}
async function insertMarket(tx: Transaction, target: typeof owned) {
  const id = await newId();
  const [row] = await tx
    .insert(markets)
    .values({
      id,
      question: 'Will MCP list every open position?',
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      endDate: new Date(now.getTime() + 86400000),
      updatedAt: now,
    })
    .returning({
      id: markets.id,
      canonical: sql<string>`to_jsonb(${markets})::text`,
    });
  assert.ok(row);
  target.markets.set(row.id, row.canonical);
  return row.id;
}
function perpRow(
  id: string,
  userId: string,
  closedAt: Date | null,
  short = false
): typeof perpPositions.$inferInsert {
  // Service size is notional: 25 * (110-100)/100 = 2.5, not 250.
  return {
    id,
    userId,
    ticker: 'ACME',
    organizationId: `org-${id}`,
    side: short ? 'short' : 'long',
    entryPrice: 100,
    currentPrice: short ? 90 : 110,
    size: short ? 40 : 25,
    leverage: 2,
    liquidationPrice: short ? 150 : 50,
    unrealizedPnL: short ? 4 : 2.5,
    unrealizedPnLPercent: 10,
    fundingPaid: short ? -0.75 : 1.25,
    openedAt: new Date(now.getTime() - (short ? 2000 : 1000)),
    lastUpdated: now,
    closedAt,
  };
}
function parentGuard(
  table: 'Position' | 'PerpPosition' | 'Market' | 'User' | 'UserApiKey'
) {
  if (table === 'Position' || table === 'PerpPosition')
    return sql`NOT EXISTS(SELECT 1 FROM "Feedback" f WHERE f."positionId"=t.id)`;
  if (table === 'Market')
    return sql`
    NOT EXISTS(SELECT 1 FROM "Question" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Position" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "PredictionPriceHistory" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "NPCTrade" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "AgentTrade" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "PoolPosition" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "FeedEvent" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TradeAttempt" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TradingFee" f WHERE f."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TradingFeeOutbox" f WHERE f."marketId"=t.id)`;
  if (table === 'User')
    return sql`
    NOT EXISTS(SELECT 1 FROM "GameOnboarding" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Whitelist" f WHERE f."userId"=t.id OR f."grantedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "WhitelistConfig" f WHERE f."updatedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Position" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "PerpPosition" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserApiKey" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "BalanceTransaction" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "PointsTransaction" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TradingFee" f WHERE f."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TradingFeeOutbox" f WHERE f."userId"=t.id)`;
  return sql`true`;
}
async function cleanup(target = owned) {
  await db.transaction(async (tx) => {
    // FOR UPDATE drains earlier FK writers before guarded parent DELETE snapshots.
    for (const [table, rows] of [
      [users, target.users],
      [markets, target.markets],
    ] as const) {
      const ids = [...rows.keys()].sort();
      if (ids.length)
        await tx
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, ids))
          .orderBy(table.id)
          .for('update');
    }
    for (const [table, rows] of [
      ['Position', target.positions],
      ['PerpPosition', target.perps],
      ['UserApiKey', target.keys],
      ['Market', target.markets],
      ['User', target.users],
    ] as const) {
      for (const [id, canonical] of rows) {
        // Key validation can update only this audit field, including after the response.
        const exact =
          table === 'UserApiKey'
            ? sql`(to_jsonb(t)-'lastUsedAt')=(${canonical}::text::jsonb-'lastUsedAt') AND (t."lastUsedAt" IS NULL OR t."lastUsedAt" BETWEEN ${firstKeyUse.toISOString()}::text::timestamp AND (clock_timestamp() AT TIME ZONE 'UTC'))`
            : sql`to_jsonb(t)=${canonical}::text::jsonb`;
        const deleted = await tx.execute<{ id: string }>(
          sql`DELETE FROM ${sql.identifier(table)} t WHERE t.id=${id} AND ${exact} AND ${parentGuard(table)} RETURNING t.id`
        );
        if (deleted.length !== 1 || deleted[0]?.id !== id)
          throw new Error(`Owned ${table} cleanup refused`);
      }
    }
  });
  for (const rows of Object.values(target)) rows.clear();
}
async function snapshot(target = owned) {
  const rows: Array<{ table: string; id: string; canonical: string }> = [];
  for (const [table, ownedRows] of [
    ['Position', target.positions],
    ['PerpPosition', target.perps],
    ['Market', target.markets],
    ['User', target.users],
  ] as const)
    for (const id of ownedRows.keys())
      rows.push(
        ...(await db.execute<{ table: string; id: string; canonical: string }>(
          sql`SELECT ${table}::text AS "table",id,to_jsonb(t)::text AS canonical FROM ${sql.identifier(table)} t WHERE id=${id}`
        ))
      );
  return rows;
}
async function releaseForeign() {
  for (const [id, canonical] of foreignQuestions) {
    const removed = await db
      .delete(questions)
      .where(
        and(
          eq(questions.id, id),
          sql`to_jsonb(${questions})=${canonical}::text::jsonb`,
          sql`NOT EXISTS(SELECT 1 FROM "ArcState" f WHERE f."questionId"=${questions.id}) AND NOT EXISTS(SELECT 1 FROM "QuestionArcPlan" f WHERE f."questionId"=${questions.id}) AND NOT EXISTS(SELECT 1 FROM "TimeframedMarket" f WHERE f."questionId"=${questions.id})`
        )
      )
      .returning({ id: questions.id });
    assert.equal(removed.length, 1);
    foreignQuestions.delete(id);
  }
  for (const [id, canonical] of foreignOnboarding) {
    const removed = await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, id),
          sql`to_jsonb(${gameOnboarding})=${canonical}::text::jsonb`
        )
      )
      .returning({ id: gameOnboarding.id });
    assert.equal(removed.length, 1);
    foreignOnboarding.delete(id);
  }
}

const PositionResult = z.object({
  positions: z.array(
    z.object({
      id: z.string(),
      marketId: z.string(),
      question: z.string().nullable(),
      side: z.enum(['YES', 'NO']),
      shares: z.string(),
      avgPrice: z.string(),
    })
  ),
  perpPositions: z.array(
    z.object({
      id: z.string(),
      ticker: z.string(),
      side: z.enum(['LONG', 'SHORT']),
      size: z.string(),
      entryPrice: z.string(),
      currentPrice: z.string(),
      leverage: z.number(),
      unrealizedPnL: z.string(),
      fundingPaid: z.string(),
    })
  ),
});
async function mcp(method: string, params: object, key: string | undefined) {
  const id = crypto.randomUUID();
  const response = await fetch(new URL('/api/mcp', server), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'X-Feed-Api-Key': key } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(new URL(response.url).origin, server.origin);
  return { response, id };
}
async function httpPositions(userId: string, args: GetPositionsArgs = {}) {
  const key = keys.get(userId);
  assert.ok(key);
  const { response, id } = await mcp(
    'tools/call',
    {
      name: 'get_positions',
      arguments: {
        ...args,
        userId: userId === agentUserId ? otherUserId : agentUserId,
      },
    },
    key
  );
  expect(response.status).toBe(200);
  const envelope = z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.string(),
      result: z.object({
        isError: z.boolean(),
        content: z.array(
          z.object({ type: z.literal('text'), text: z.string() })
        ),
      }),
    })
    .parse(await response.json());
  expect(envelope.id).toBe(id);
  expect(envelope.result.isError).toBe(false);
  expect(envelope.result.content).toHaveLength(1);
  assert.ok(envelope.result.content[0]);
  return PositionResult.parse(JSON.parse(envelope.result.content[0].text));
}

beforeAll(async () => {
  const setup = await db.transaction(async (tx) => {
    const rows = receipts();
    const owner = await insertUser(tx, rows);
    const other = await insertUser(tx, rows);
    const empty = await insertUser(tx, rows);
    const market = await insertMarket(tx, rows);
    const predictionIds = [await newId(), await newId()];
    const predictionRows = await tx
      .insert(positions)
      .values(
        predictionIds.map((id, i) => ({
          id,
          userId: owner,
          marketId: market,
          side: i === 0,
          shares: i === 0 ? '10' : '4',
          avgPrice: '0.5',
          amount: i === 0 ? '5' : '2',
          status: 'active',
          updatedAt: now,
        }))
      )
      .returning({
        id: positions.id,
        canonical: sql<string>`to_jsonb(${positions})::text`,
      });
    for (const row of predictionRows) rows.positions.set(row.id, row.canonical);
    assert.equal(predictionRows.length, 2);
    const perpIds = [
      await newId(),
      await newId(),
      await newId(),
      await newId(),
    ];
    const [long, short, closed, bystander] = perpIds;
    assert.ok(long && short && closed && bystander);
    const perps = await tx
      .insert(perpPositions)
      .values([
        perpRow(long, owner, null),
        perpRow(short, owner, null, true),
        perpRow(closed, owner, now),
        perpRow(bystander, other, null),
      ])
      .returning({
        id: perpPositions.id,
        canonical: sql<string>`to_jsonb(${perpPositions})::text`,
      });
    for (const row of perps) rows.perps.set(row.id, row.canonical);
    assert.equal(perps.length, 4);
    const rawKeys = new Map<string, string>();
    for (const userId of [owner, other, empty]) {
      const raw = generateApiKey();
      const [key] = await tx
        .insert(userApiKeys)
        .values({
          id: await newId(),
          userId,
          keyHash: hashApiKey(raw),
          name: 'Owned MCP portfolio fixture',
          expiresAt: new Date(now.getTime() + 3600000),
        })
        .returning({
          id: userApiKeys.id,
          canonical: sql<string>`to_jsonb(${userApiKeys})::text`,
        });
      assert.ok(key);
      rows.keys.set(key.id, key.canonical);
      rawKeys.set(userId, raw);
    }
    return {
      rows,
      owner,
      other,
      empty,
      market,
      predictionIds,
      long,
      short,
      closed,
      bystander,
      rawKeys,
    };
  });
  // No receipt or credential is published until the entire setup commits.
  for (const table of Object.keys(owned) as Array<keyof typeof owned>)
    for (const [id, row] of setup.rows[table]) owned[table].set(id, row);
  agentUserId = setup.owner;
  otherUserId = setup.other;
  emptyUserId = setup.empty;
  marketId = setup.market;
  assert.ok(setup.predictionIds[0] && setup.predictionIds[1]);
  activePredictionId = setup.predictionIds[0];
  secondPredictionId = setup.predictionIds[1];
  openPerpId = setup.long;
  shortPerpId = setup.short;
  closedPerpId = setup.closed;
  otherPerpId = setup.bystander;
  for (const [user, key] of setup.rawKeys) keys.set(user, key);
  firstKeyUse = new Date();
});
afterAll(async () => {
  await releaseForeign();
  await cleanup(controls);
  await cleanup();
});

describe('MCP get_positions perpetual coverage', () => {
  it('still lists the open prediction position (guard)', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(new Set(result.positions.map((p) => p.id))).toEqual(
      new Set([activePredictionId, secondPredictionId])
    );
    const prediction = result.positions.find(
      (p) => p.id === activePredictionId
    );
    expect(prediction).toMatchObject({ marketId, side: 'YES' });
    expect(Number(prediction?.shares)).toBe(10);
    expect(Number(prediction?.avgPrice)).toBe(0.5);
  });
  it('lists the agent open perp position alongside prediction positions', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(result.perpPositions).toBeDefined();
    expect(result.perpPositions.map((p) => p.id)).toEqual([
      openPerpId,
      shortPerpId,
    ]);
    expect(result.perpPositions[0]).toMatchObject({
      id: openPerpId,
      ticker: 'ACME',
      side: 'LONG',
      size: '25',
      entryPrice: '100',
      currentPrice: '110',
      leverage: 2,
      unrealizedPnL: '2.5',
      fundingPaid: '1.25',
    });
  });
  it('excludes closed perps and other users perps', async () => {
    const result = await executeGetPositions(agent(), {});
    const ids = (result.perpPositions ?? []).map((p) => p.id);
    expect(ids).not.toContain(closedPerpId);
    expect(ids).not.toContain(otherPerpId);
  });
  it('returns no perp positions when a marketId filter is given', async () => {
    const result = await executeGetPositions(agent(), { marketId });
    expect(new Set(result.positions.map((p) => p.id))).toEqual(
      new Set([activePredictionId, secondPredictionId])
    );
    expect(result.perpPositions ?? []).toEqual([]);
  });
  it('preserves stored SHORT PnL and signed funding without recalculating either', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(
      result.perpPositions.find((p) => p.id === shortPerpId)
    ).toMatchObject({
      side: 'SHORT',
      size: '40',
      currentPrice: '90',
      unrealizedPnL: '4',
      fundingPaid: '-0.75',
    });
  });
  it('paginates predictions only and repeats the complete open perp set on every page', async () => {
    const all = await executeGetPositions(agent(), {});
    const first = await executeGetPositions(agent(), { limit: 1, offset: 0 });
    const second = await executeGetPositions(agent(), { limit: 1, offset: 1 });
    const beyond = await executeGetPositions(agent(), { limit: 1, offset: 2 });
    expect(first.positions).toHaveLength(1);
    expect(second.positions).toHaveLength(1);
    expect(
      new Set([...first.positions, ...second.positions].map((p) => p.id))
    ).toEqual(new Set(all.positions.map((p) => p.id)));
    expect(beyond.positions).toEqual([]);
    for (const page of [first, second, beyond])
      expect(page.perpPositions).toEqual(all.perpPositions);
  });
  it('returns two empty arrays for an owner with no positions', async () => {
    expect(
      await executeGetPositions({ agentId: 'empty', userId: emptyUserId }, {})
    ).toEqual({ positions: [], perpPositions: [] });
  });
  it('does not acquire partial setup or failed User and PerpPosition primary-key inserts', async () => {
    const before = await snapshot();
    const failed = receipts();
    const attemptedUser = await newId();
    const attemptedPerp = await newId();
    async function partialSetup() {
      const rows = await db.transaction(async (tx) => {
        const pending = receipts();
        const [inserted] = await tx
          .insert(users)
          .values({
            id: attemptedUser,
            username: `mcppos_${attemptedUser}`,
            updatedAt: now,
          })
          .returning({
            id: users.id,
            canonical: sql<string>`to_jsonb(${users})::text`,
          });
        assert.ok(inserted);
        pending.users.set(inserted.id, inserted.canonical);
        await tx.insert(users).values({
          id: agentUserId,
          username: `collision_${attemptedUser}`,
          updatedAt: now,
        });
        return pending;
      });
      for (const [id, row] of rows.users) failed.users.set(id, row);
    }
    async function collisionPerps() {
      const rows = await db
        .insert(perpPositions)
        .values([
          perpRow(attemptedPerp, agentUserId, null),
          perpRow(openPerpId, agentUserId, null),
        ])
        .returning({
          id: perpPositions.id,
          canonical: sql<string>`to_jsonb(${perpPositions})::text`,
        });
      for (const row of rows) failed.perps.set(row.id, row.canonical);
    }
    await expect(partialSetup()).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'User_pkey' },
    });
    await expect(collisionPerps()).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'PerpPosition_pkey' },
    });
    expect(Object.values(failed).every((rows) => rows.size === 0)).toBe(true);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, attemptedUser))
    ).toEqual([]);
    expect(
      await db
        .select({ id: perpPositions.id })
        .from(perpPositions)
        .where(eq(perpPositions.id, attemptedPerp))
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it('rolls cleanup back and preserves foreign Question and User cascade references', async () => {
    const setup = await db.transaction(async (tx) => {
      const rows = receipts();
      const user = await insertUser(tx, rows);
      const market = await insertMarket(tx, rows);
      const [position] = await tx
        .insert(positions)
        .values({
          id: await newId(),
          userId: user,
          marketId: market,
          side: true,
          shares: '1',
          avgPrice: '0.5',
          status: 'active',
          updatedAt: now,
        })
        .returning({
          id: positions.id,
          canonical: sql<string>`to_jsonb(${positions})::text`,
        });
      assert.ok(position);
      rows.positions.set(position.id, position.canonical);
      return { rows, user, market };
    });
    for (const table of Object.keys(controls) as Array<keyof typeof controls>)
      for (const [id, row] of setup.rows[table]) controls[table].set(id, row);
    const questionId = await newId();
    const [question] = await db
      .insert(questions)
      .values({
        id: questionId,
        questionNumber: 1000000000 + Number(questionId.slice(-8)),
        marketId: setup.market,
        text: 'Foreign Question cleanup refusal',
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(now.getTime() + 86400000),
        updatedAt: now,
      })
      .returning({
        id: questions.id,
        canonical: sql<string>`to_jsonb(${questions})::text`,
      });
    assert.ok(question);
    foreignQuestions.set(question.id, question.canonical);
    const [onboarding] = await db
      .insert(gameOnboarding)
      .values({ id: await newId(), userId: setup.user, updatedAt: now })
      .returning({
        id: gameOnboarding.id,
        canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
      });
    assert.ok(onboarding);
    foreignOnboarding.set(onboarding.id, onboarding.canonical);
    const before = await snapshot(controls);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned Market cleanup refused'
    );
    expect(await snapshot(controls)).toEqual(before);
    expect(
      await db
        .select({ canonical: sql<string>`to_jsonb(${questions})::text` })
        .from(questions)
        .where(eq(questions.id, question.id))
    ).toEqual([{ canonical: question.canonical }]);
    // Release only this exact independently acquired control, never by parent ID.
    const removed = await db
      .delete(questions)
      .where(
        and(
          eq(questions.id, question.id),
          sql`to_jsonb(${questions})=${question.canonical}::text::jsonb`,
          sql`NOT EXISTS(SELECT 1 FROM "ArcState" f WHERE f."questionId"=${questions.id}) AND NOT EXISTS(SELECT 1 FROM "QuestionArcPlan" f WHERE f."questionId"=${questions.id}) AND NOT EXISTS(SELECT 1 FROM "TimeframedMarket" f WHERE f."questionId"=${questions.id})`
        )
      )
      .returning({ id: questions.id });
    expect(removed).toEqual([{ id: question.id }]);
    foreignQuestions.delete(question.id);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned User cleanup refused'
    );
    expect(await snapshot(controls)).toEqual(before);
    expect(
      await db
        .select({ canonical: sql<string>`to_jsonb(${gameOnboarding})::text` })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, onboarding.id))
    ).toEqual([{ canonical: onboarding.canonical }]);
    await releaseForeign();
    await cleanup(controls);
  });
  it('uses normal MCP discovery, credential refusal and authenticated-owner dispatch over HTTP', async () => {
    const before = await snapshot();
    for (const key of [undefined, generateApiKey()]) {
      const { response } = await mcp(
        'tools/call',
        { name: 'get_positions', arguments: {} },
        key
      );
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    const key = keys.get(agentUserId);
    assert.ok(key);
    const listing = await mcp('tools/list', {}, key);
    expect(listing.response.status).toBe(200);
    const tools = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({ name: z.string(), description: z.string() })
          ),
        }),
      })
      .parse(await listing.response.json());
    expect(
      tools.result.tools.find((tool) => tool.name === 'get_positions')
        ?.description
    ).toContain('Pagination applies only to predictions');
    const owner = await httpPositions(agentUserId);
    expect(owner.perpPositions.map((p) => p.id)).toEqual([
      openPerpId,
      shortPerpId,
    ]);
    expect(new Set(owner.positions.map((p) => p.id))).toEqual(
      new Set([activePredictionId, secondPredictionId])
    );
    const other = await httpPositions(otherUserId);
    expect(other.perpPositions.map((p) => p.id)).toEqual([otherPerpId]);
    expect(other.positions).toEqual([]);
    expect(await httpPositions(emptyUserId)).toEqual({
      positions: [],
      perpPositions: [],
    });
    expect(
      (await httpPositions(agentUserId, { marketId })).perpPositions
    ).toEqual([]);
    const page = await httpPositions(agentUserId, { limit: 1, offset: 1 });
    expect(page.positions).toHaveLength(1);
    expect(page.perpPositions).toEqual(owner.perpPositions);
    expect(await snapshot()).toEqual(before);
  });
});
