/**
 * PRD §9.2 / MVP Phase 6: preserve prediction discovery and lifecycle.
 * Real database, route, signed verifier and process-local memory cache.
 * The prescribed integration runner isolates each file in a Bun process.
 * Clock and valid RNG samples select the deterministic no-early-refresh
 * branch; this is not live probabilistic, Redis/CDN or financial evidence.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCache,
  getRedisClient,
  invalidateCache,
  optionalAuth,
} from '@feed/api';
import { db, eq, questions, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { GET as getWidgetMarkets } from '@/app/api/feed/widgets/markets/route';
import { createStewardTestToken } from './helpers/steward-auth';

// Refuse unintended destinations before a lazy DB client runs a query.
function databaseTarget(value: string | undefined) {
  if (!value) throw new Error('Explicit disposable database required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !(
      (port === '55685' &&
        /^feed_pr\d+$/.test(name) &&
        url.username === 'symbiex') ||
      (port === '5432' && name === 'test_db' && process.env.CI === 'true')
    )
  )
    throw new Error('Disposable loopback database required');
  return `${port}/${name}/${url.username}`;
}
const primary = databaseTarget(process.env.DATABASE_URL);
if (
  process.env.DATABASE_READ_REPLICA_URL?.trim() ||
  (process.env.DIRECT_DATABASE_URL &&
    databaseTarget(process.env.DIRECT_DATABASE_URL) !== primary)
)
  throw new Error('Widget fixture requires one disposable primary');

const prefix = `widget-expiry-${crypto.randomUUID()}`;
const questionIds = new Set<string>();
const userIds = new Set<string>();
const cacheKey = 'markets-widget-v2';
const cacheOptions = { namespace: CACHE_KEYS.WIDGET };
const endpoint = 'http://localhost/api/feed/widgets/markets';
const marketSchema = z.array(z.object({ id: z.string() }));
const responseSchema = z.object({
  success: z.literal(true),
  markets: marketSchema,
});
let questionNumber = 1_800_000_000 + Math.floor(Math.random() * 100_000_000);
let ownsCache = false;
let clock = 0;
let liveId = '';
let expiredId = '';
let resolvedId = '';
let boundaryId = '';
let viewerId = '';
let token = '';

async function createQuestion(
  suffix: string,
  status: string,
  resolutionDate: Date,
  registry = questionIds
): Promise<string> {
  const inserted = await db
    .insert(questions)
    .values({
      id: `${prefix}-${suffix}`,
      questionNumber: questionNumber++,
      text: `Widget expiry fixture ${suffix}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      status,
      resolutionDate,
      updatedAt: new Date(),
    })
    .returning({ id: questions.id });
  for (const row of inserted) {
    registry.add(row.id);
    questionIds.add(row.id);
  }
  const [created] = inserted;
  if (!created || inserted.length !== 1)
    throw new Error('Question insert returned no row');
  return created.id;
}

async function cleanupQuestions(registry: Set<string>) {
  const results = await Promise.allSettled(
    [...registry].map(async (id) => {
      await db.delete(questions).where(eq(questions.id, id));
      registry.delete(id);
      questionIds.delete(id);
    })
  );
  return results.flatMap((result) =>
    result.status === 'rejected'
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
        ]
      : []
  );
}

async function clearOwnedCache() {
  if (!ownsCache) throw new Error('Widget cache ownership not established');
  expect(getRedisClient()).toBeNull();
  await invalidateCache(cacheKey, cacheOptions);
}

async function widget(headers: Record<string, string> = {}) {
  // A valid sample near one suppresses only optional early refresh. Every
  // route call is awaited, so teardown has no detached refresh from this file.
  const random = spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
  try {
    const response = await getWidgetMarkets(
      new NextRequest(endpoint, { headers })
    );
    expect(response.status).toBe(200);
    return responseSchema.parse(await response.json()).markets.map((m) => m.id);
  } finally {
    random.mockRestore();
  }
}

async function cachedIds() {
  return marketSchema
    .parse(await getCache(cacheKey, cacheOptions))
    .map((market) => market.id);
}

function signedHeaders(cookie = false): Record<string, string> {
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}

function expectColdMembership(ids: string[]) {
  // These live questions deliberately have no Market row: existing defaults
  // and top-ten membership remain available without proving a funded buy.
  expect(ids).toContain(liveId);
  expect(ids).toContain(boundaryId);
  expect(ids).not.toContain(expiredId);
  expect(ids).not.toContain(resolvedId);
}

beforeAll(async () => {
  expect(process.env.NODE_ENV).toBe('test');
  expect(getRedisClient()).toBeNull();
  expect(await getCache(cacheKey, cacheOptions)).toBeNull();
  ownsCache = true;
  const [latest] = await db
    .select({
      date: sql<string | null>`max(${questions.resolutionDate})::text`,
    })
    .from(questions);
  // No unrelated row is changed: advance past its deadline so owned live
  // controls deterministically occupy the candidate's existing top-ten list.
  clock =
    Math.max(Date.now(), latest?.date ? new Date(latest.date).getTime() : 0) +
    24 * 60 * 60 * 1000;
  if (!Number.isFinite(clock)) throw new Error('Invalid fixture clock');
  liveId = await createQuestion('live', 'active', new Date(clock + 86_400_000));
  expiredId = await createQuestion(
    'expired',
    'active',
    new Date(clock - 3_600_000)
  );
  resolvedId = await createQuestion(
    'resolved',
    'resolved',
    new Date(clock - 86_400_000)
  );
  boundaryId = await createQuestion(
    'boundary',
    'active',
    new Date(clock + 1000)
  );
  const candidateId = await generateSnowflakeId();
  const stewardId = `${prefix}-viewer`;
  const inserted = await db
    .insert(users)
    .values({
      id: candidateId,
      username: `${prefix}-viewer`,
      privyId: stewardId,
      stewardId,
      displayName: 'Widget Expiry Viewer',
      isTest: true,
      isAgent: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) userIds.add(row.id);
  const [created] = inserted;
  if (!created || inserted.length !== 1)
    throw new Error('Viewer insert returned no row');
  viewerId = created.id;
  setSystemTime(new Date(clock));
  try {
    token = await createStewardTestToken(stewardId);
  } finally {
    setSystemTime();
  }
});

beforeEach(async () => {
  setSystemTime(new Date(clock));
  await clearOwnedCache();
});

afterEach(async () => {
  try {
    if (ownsCache) await clearOwnedCache();
  } finally {
    setSystemTime();
  }
});

afterAll(async () => {
  setSystemTime();
  const results = await Promise.allSettled([
    cleanupQuestions(questionIds).then((errors) => {
      if (errors.length)
        throw new AggregateError(errors, 'Question cleanup failed');
    }),
    ...[...userIds].map(async (id) => {
      await db.delete(users).where(eq(users.id, id));
      userIds.delete(id);
    }),
    ...(ownsCache ? [clearOwnedCache()] : []),
  ]);
  const errors = results.flatMap((result) =>
    result.status === 'rejected'
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
        ]
      : []
  );
  if (errors.length)
    throw new AggregateError(errors, 'Owned widget cleanup failed');
});

describe('markets widget expiry', () => {
  test('cold public widget retains live unbacked questions and excludes expired and resolved controls', async () => {
    expectColdMembership(await widget());
  });

  test('signed identities bypass the primed public cache while ignored or invalid credentials stay public', async () => {
    expectColdMembership(await widget());
    const primed = await cachedIds();
    setSystemTime(new Date(clock + 1001));
    for (const headers of [signedHeaders(), signedHeaders(true)]) {
      expect(
        (await optionalAuth(new NextRequest(endpoint, { headers })))?.userId
      ).toBe(viewerId);
      const ids = await widget(headers);
      expect(ids).toContain(liveId);
      expect(ids).not.toContain(boundaryId);
      expect(ids).not.toContain(expiredId);
      expect(ids).not.toContain(resolvedId);
      expect(await cachedIds()).toEqual(primed);
    }
    const anonymousHeaders: Record<string, string>[] = [
      { 'x-dev-user-id': viewerId },
      { authorization: 'Bearer invalid-token' },
    ];
    for (const headers of anonymousHeaders) {
      expect(
        await optionalAuth(new NextRequest(endpoint, { headers }))
      ).toBeNull();
      expect(await widget(headers)).toEqual(primed);
    }
  });

  test('cold public and signed views include deadline equality and exclude the next millisecond', async () => {
    for (const delta of [-1, 0, 1]) {
      setSystemTime(new Date(clock + 1000 + delta));
      await clearOwnedCache();
      for (const headers of [{}, signedHeaders()]) {
        const ids = await widget(headers);
        expect(ids).toContain(liveId);
        expect(ids.includes(boundaryId)).toBe(delta <= 0);
        expect(ids).not.toContain(expiredId);
        expect(ids).not.toContain(resolvedId);
      }
    }
  });

  test('the no-early-refresh warm snapshot can retain an ended question until cache expiry', async () => {
    expectColdMembership(await widget());
    const primed = await cachedIds();
    setSystemTime(new Date(clock + (DEFAULT_TTLS.WIDGET - 2) * 1000));
    expect(await widget()).toEqual(primed);
    expect(primed).toContain(boundaryId);
    setSystemTime(new Date(clock + DEFAULT_TTLS.WIDGET * 1000));
    const refreshed = await widget();
    expect(refreshed).toContain(liveId);
    expect(refreshed).not.toContain(boundaryId);
    expect(refreshed).not.toContain(expiredId);
    expect(refreshed).not.toContain(resolvedId);
  });

  test('partial setup cleanup preserves an independently inserted collision control', async () => {
    const setup = new Set<string>();
    const control = new Set<string>();
    const controlId = await createQuestion(
      'collision-control',
      'resolved',
      new Date(clock),
      control
    );
    try {
      const [before] = await db
        .select()
        .from(questions)
        .where(eq(questions.id, controlId));
      expect(before?.id).toBe(controlId);
      await expect(
        (async () => {
          await createQuestion('partial', 'resolved', new Date(clock), setup);
          await createQuestion(
            'collision-control',
            'resolved',
            new Date(clock),
            setup
          );
        })()
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect([...setup]).toEqual([`${prefix}-partial`]);
      expect(await cleanupQuestions(setup)).toEqual([]);
      expect(
        await db
          .select()
          .from(questions)
          .where(eq(questions.id, `${prefix}-partial`))
      ).toEqual([]);
      const [after] = await db
        .select()
        .from(questions)
        .where(eq(questions.id, controlId));
      expect(after).toEqual(before);
    } finally {
      const results = await Promise.allSettled([
        cleanupQuestions(setup),
        cleanupQuestions(control),
      ]);
      const errors = results.flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value
          : [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ]
      );
      if (errors.length)
        throw new AggregateError(errors, 'Collision cleanup failed');
    }
  });
});
