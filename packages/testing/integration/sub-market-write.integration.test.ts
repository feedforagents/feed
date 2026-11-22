import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();
  const { db, eq, games, inArray, markets, questions, sql, timeframedMarkets } =
    await import('@feed/db');
  const { writeSubMarket } = await import('@feed/engine');

  // This test needs an isolated database: the sub-market cap is global.
  const prefix = `sub-market-test-${randomUUID()}`;
  const gameId = `${prefix}-game`;
  const parentId = `${prefix}-parent`;
  let ids: string[] = [];
  let questionIds: string[] = [];
  let sequence = 0;
  const control = postgres(process.env.DATABASE_URL!, { max: 2 });

  function prepared() {
    const id = `${prefix}-${++sequence}`;
    ids.push(id);
    questionIds.push(`${id}-question`);
    return {
      parentId,
      category: 'general' as const,
      questionId: `${id}-question`,
      questionNumber: 1_000_000 + sequence,
      questionText: `Will ${id} happen?`,
      expectedOutcome: true,
      resolutionCriteria: 'The event occurs.',
      timeframedMarketId: id,
      durationMs: 15 * 60 * 1000,
      timeframe: '15m' as const,
      topic: { topicKey: 'test', topicLabel: 'Test', date: new Date() },
      arcState: 'setup' as const,
      affiliatedActorIds: [],
      affiliatedOrgIds: [],
      gameId,
      dayNumber: 1,
    };
  }

  async function lockCap() {
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = control.begin(async (tx) => {
      await tx.unsafe(
        "SELECT pg_advisory_xact_lock(hashtext('markets-tick:sub-market-cap'))"
      );
      locked();
      await released;
    });
    await ready;
    return async () => {
      release();
      await transaction;
    };
  }

  async function waitForBlockedWriters(expected: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [result] = await control<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
          AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'
      `;
      if (result && result.count >= expected) return;
      await Bun.sleep(25);
    }
    throw new Error(
      `Timed out waiting for ${expected} blocked sub-market writers`
    );
  }

  beforeAll(async () => {
    const [existing] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(timeframedMarkets);
    if (existing?.count !== 0)
      throw new Error(
        'Sub-market integration test requires an empty disposable database'
      );
    await db.insert(games).values({ id: gameId, updatedAt: new Date() });
  });

  beforeEach(async () => {
    const now = new Date();
    await db.insert(timeframedMarkets).values({
      id: parentId,
      timeframe: 'daily',
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      arcStateEnteredAt: now,
    });
  });

  afterEach(async () => {
    await db
      .delete(timeframedMarkets)
      .where(inArray(timeframedMarkets.id, [...ids, parentId]));
    if (questionIds.length) {
      await db.delete(markets).where(inArray(markets.id, questionIds));
      await db.delete(questions).where(inArray(questions.id, questionIds));
    }
    ids = [];
    questionIds = [];
  });

  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await db.delete(games).where(eq(games.id, gameId));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
    }
    const closed = await Promise.allSettled([control.end(), db.$disconnect()]);
    for (const result of closed) {
      if (result.status === 'rejected')
        failures.push(
          result.reason instanceof Error
            ? result.reason
            : new Error('Child connection close failed')
        );
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Sub-market child teardown incomplete'
      );
  });

  describe('sub-market transactional creation', () => {
    test('concurrent writers serialize the last available slot', async () => {
      const now = new Date();
      const children = Array.from({ length: 9 }, (_, index) => ({
        id: `${prefix}-existing-${index}`,
        parentMarketId: parentId,
        timeframe: 'flash' as const,
        startTime: now,
        endTime: new Date(now.getTime() + 60 * 60 * 1000),
        arcStateEnteredAt: now,
      }));
      ids.push(...children.map((child) => child.id));
      await db.insert(timeframedMarkets).values(children);
      const a = prepared();
      const b = prepared();
      const unlock = await lockCap();
      const writes = Promise.all([writeSubMarket(a), writeSubMarket(b)]);
      try {
        await waitForBlockedWriters(2);
      } finally {
        await unlock();
      }
      const results = await writes;
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? a : b;
      const loser = results[0] ? b : a;
      const rows = await db
        .select()
        .from(timeframedMarkets)
        .where(eq(timeframedMarkets.parentMarketId, parentId));
      expect(rows).toHaveLength(10);
      expect(
        rows.some(
          (row) =>
            row.id === winner.timeframedMarketId &&
            row.questionId === winner.questionId
        )
      ).toBe(true);
      expect(
        await db
          .select()
          .from(questions)
          .where(eq(questions.id, winner.questionId))
      ).toHaveLength(1);
      expect(
        await db.select().from(markets).where(eq(markets.id, winner.questionId))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(questions)
          .where(eq(questions.id, loser.questionId))
      ).toHaveLength(0);
      expect(
        await db.select().from(markets).where(eq(markets.id, loser.questionId))
      ).toHaveLength(0);
    });

    for (const change of ['inactive', 'expired'] as const) {
      test(`rechecks an ${change} parent after waiting for the cap lock`, async () => {
        const input = prepared();
        const unlock = await lockCap();
        const write = writeSubMarket(input);
        try {
          await waitForBlockedWriters(1);
          await db
            .update(timeframedMarkets)
            .set(
              change === 'inactive'
                ? { isActive: false }
                : { endTime: new Date() }
            )
            .where(eq(timeframedMarkets.id, parentId));
        } finally {
          await unlock();
        }
        expect(await write).toBe(false);
        expect(
          await db
            .select()
            .from(questions)
            .where(eq(questions.id, input.questionId))
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(markets)
            .where(eq(markets.id, input.questionId))
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(timeframedMarkets)
            .where(eq(timeframedMarkets.id, input.timeframedMarketId))
        ).toHaveLength(0);
      });
    }

    test('rolls back question and prediction market if the final insert fails', async () => {
      const input = prepared();
      // The parent ID already exists, so only the final insertion violates a key.
      await expect(
        writeSubMarket({ ...input, timeframedMarketId: parentId })
      ).rejects.toThrow();
      expect(
        await db
          .select()
          .from(questions)
          .where(eq(questions.id, input.questionId))
      ).toHaveLength(0);
      expect(
        await db.select().from(markets).where(eq(markets.id, input.questionId))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(timeframedMarkets)
          .where(eq(timeframedMarkets.id, parentId))
      ).toHaveLength(1);
    });
  });
} else {
  test('runs all four original sub-market cases in a leased fresh database', async () => {
    await runIsolatedSubMarketCases();
  }, 240_000);
}
