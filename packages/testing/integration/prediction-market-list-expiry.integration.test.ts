/** PRD §9.2 / MVP Phase 6: preserve the existing prediction lifecycle. */
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import { db, eq, markets, sql, type Transaction } from '@feed/db';

type Client = typeof db | Transaction;
interface MarketFixture {
  id: string;
  endDate: Date;
  createdAt: Date;
  resolved: boolean;
}

function makeService(client: Client = db) {
  // These cases exercise list/count/direct reads only. The inert wallet is
  // isolation, not evidence for funded buys, position exits or settlement.
  return new PredictionMarketService({
    db: new PredictionDbAdapter(client),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 0 }),
    },
    fees: {
      tradingFeeRate: 0,
      platformShare: 0,
      referrerShare: 0,
      minFeeAmount: 0,
    },
  });
}

async function insertMarkets(
  client: Client,
  owned: Set<string>,
  fixtures: MarketFixture[]
) {
  const inserted = await client
    .insert(markets)
    .values(
      fixtures.map((fixture) => ({
        ...fixture,
        question: `Fixture market ${fixture.id}`,
        liquidity: '1000',
        yesShares: '100',
        noShares: '100',
        resolution: fixture.resolved ? true : null,
        updatedAt: fixture.createdAt,
      }))
    )
    .returning({ id: markets.id });
  // Register actual INSERT results before any assertion can throw. An ID
  // merely attempted by a failed INSERT never grants deletion ownership.
  for (const row of inserted) owned.add(row.id);
  expect(inserted.map((row) => row.id).sort()).toEqual(
    fixtures.map((fixture) => fixture.id).sort()
  );
}

async function cleanup(client: Client, owned: Set<string>) {
  const results = await Promise.allSettled(
    [...owned].map(async (id) => {
      await client.delete(markets).where(eq(markets.id, id));
      owned.delete(id);
    })
  );
  const failures: Error[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason))
      );
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Owned expiry fixture cleanup failed');
  }
}

describe('prediction market trading list expiry', () => {
  test('SQL filtering preserves exact pages and total beyond fifty live rows', async () => {
    const now = new Date('2035-01-01T12:00:00.000Z');
    setSystemTime(now);
    try {
      await db.transaction(async (tx) => {
        // Freeze the query clock and database snapshot so unrelated writes or
        // deadlines cannot invalidate a before/after global count assertion.
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        const service = makeService(tx);
        const before = await service.listMarkets();
        expect(await service.countUnresolvedMarkets()).toBe(before.length);
        const [bounds] = await tx
          .select({
            latest: sql<string | null>`max(${markets.createdAt})::text`,
          })
          .from(markets);
        const firstCreatedAt =
          Math.max(
            now.getTime(),
            bounds?.latest ? new Date(bounds.latest).getTime() : 0
          ) + 1000;
        const prefix = `list-expiry-${crypto.randomUUID()}`;
        const owned = new Set<string>();
        const fixtures: MarketFixture[] = [];
        const liveIds: string[] = [];
        // All owned timestamps are distinct and newer than existing rows.
        // Excluded rows interleave with 61 live rows before SQL pagination.
        for (let index = 0; index < 61; index++) {
          for (const [kind, slot] of ['live', 'expired', 'resolved'].map(
            (kind, slot) => [kind, slot] as const
          )) {
            const id = `${prefix}-${kind}-${index}`;
            if (kind === 'live') liveIds.unshift(id);
            fixtures.push({
              id,
              endDate: new Date(
                now.getTime() + (kind === 'expired' ? -1000 : 86_400_000)
              ),
              createdAt: new Date(firstCreatedAt + (index * 3 + slot) * 1000),
              resolved: kind === 'resolved',
            });
          }
        }
        try {
          await insertMarkets(tx, owned, fixtures);
          const all = await service.listMarkets();
          expect(all.map((row) => row.id).sort()).toEqual(
            [...before.map((row) => row.id), ...liveIds].sort()
          );
          expect(await service.countUnresolvedMarkets()).toBe(
            before.length + 61
          );
          const seen: string[] = [];
          const offsets: number[] = [];
          for (let offset = 0; offset < liveIds.length; offset += 5) {
            offsets.push(offset);
            const page = await service.listMarkets({ limit: 5, offset });
            const expected = liveIds.slice(offset, offset + 5);
            expect(page).toHaveLength(Math.min(5, all.length - offset));
            expect(page.slice(0, expected.length).map((row) => row.id)).toEqual(
              expected
            );
            seen.push(
              ...page.filter((row) => owned.has(row.id)).map((row) => row.id)
            );
          }
          expect(offsets.at(-1)).toBe(60);
          expect(seen).toEqual(liveIds);
          expect(new Set(seen).size).toBe(61);
        } finally {
          await cleanup(tx, owned);
        }
        expect(await service.countUnresolvedMarkets()).toBe(before.length);
      });
    } finally {
      setSystemTime();
    }
  });

  test('deadline equality is included and expired direct lookup remains available', async () => {
    const deadline = new Date('2035-01-02T12:00:00.000Z');
    const id = `list-expiry-boundary-${crypto.randomUUID()}`;
    const owned = new Set<string>();
    try {
      await insertMarkets(db, owned, [
        {
          id,
          endDate: deadline,
          createdAt: deadline,
          resolved: false,
        },
      ]);
      const service = makeService();
      for (const delta of [-1, 0, 1]) {
        setSystemTime(new Date(deadline.getTime() + delta));
        const listed = await service.listMarkets();
        expect(listed.some((market) => market.id === id)).toBe(delta <= 0);
      }
      const direct = await new PredictionDbAdapter().getMarketById(id);
      expect(direct?.id).toBe(id);
      expect(direct?.resolved).toBe(false);
      expect(direct?.endDate).toEqual(deadline);
    } finally {
      setSystemTime();
      await cleanup(db, owned);
    }
  });

  test('partial setup cleanup preserves a real pre-existing collision row', async () => {
    const prefix = `list-expiry-collision-${crypto.randomUUID()}`;
    const setupOwned = new Set<string>();
    const survivorOwned = new Set<string>();
    const fixture = (id: string): MarketFixture => ({
      id,
      endDate: new Date('2035-01-03T12:00:00.000Z'),
      createdAt: new Date('2035-01-02T12:00:00.000Z'),
      resolved: false,
    });
    const collision = fixture(`${prefix}-survivor`);
    const partial = fixture(`${prefix}-partial`);
    try {
      await insertMarkets(db, survivorOwned, [collision]);
      const [before] = await db
        .select()
        .from(markets)
        .where(eq(markets.id, collision.id));
      expect(before?.id).toBe(collision.id);
      await expect(
        (async () => {
          await insertMarkets(db, setupOwned, [partial]);
          await insertMarkets(db, setupOwned, [collision]);
        })()
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect([...setupOwned]).toEqual([partial.id]);
      await cleanup(db, setupOwned);
      await cleanup(db, setupOwned); // Repeating successful cleanup is harmless.
      expect(
        await db.select().from(markets).where(eq(markets.id, partial.id))
      ).toEqual([]);
      const [after] = await db
        .select()
        .from(markets)
        .where(eq(markets.id, collision.id));
      expect(after).toEqual(before);
    } finally {
      // Attempt both ownership scopes even if one cleanup encounters a failure.
      const outcomes = await Promise.allSettled([
        cleanup(db, setupOwned),
        cleanup(db, survivorOwned),
      ]);
      const failures = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      if (failures.length)
        throw new AggregateError(failures, 'Collision fixture cleanup failed');
    }
  });
});
