/**
 * PRD sections 8.1 and 9.2, MVP Phase 6: MCP and A2A market discovery offer
 * the same open markets as the website trading list. A market past its
 * deadline stays unresolved until settlement runs, but it is closed for
 * trading, so get_markets and markets.list_prediction (status active) must
 * not list it and get_system_stats must not count it.
 *
 * Assertions look only at this file's fixture ids, or at count deltas that
 * only a fixture update can cause, so other rows in a shared database do not
 * change the outcome.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { PredictionDbAdapter } from '@feed/core/markets/prediction';
import { dbWrite as db, eq, markets } from '@feed/db';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import {
  executeGetMarkets,
  executeGetSystemStats,
} from '../../mcp/src/handlers/tool-handlers';
import type { AuthenticatedAgent } from '../../mcp/src/types/mcp';

const owned = new Set<string>();
const prefix = `mcp-markets-expiry-${crypto.randomUUID()}`;
const agent: AuthenticatedAgent = {
  agentId: `${prefix}-agent`,
  userId: `${prefix}-agent`,
};

async function insertMarket(
  kind: string,
  endDate: Date,
  resolved: boolean,
  createdAt: Date
) {
  const id = `${prefix}-${kind}`;
  const [row] = await db
    .insert(markets)
    .values({
      id,
      question: `Fixture market ${kind}`,
      endDate,
      createdAt,
      updatedAt: createdAt,
      resolved,
      resolution: resolved ? true : null,
      liquidity: '1000',
      yesShares: '100',
      noShares: '100',
    })
    .returning({ id: markets.id });
  if (row) owned.add(row.id);
  expect(row?.id).toBe(id);
  return id;
}

afterAll(async () => {
  const results = await Promise.allSettled(
    [...owned].map((id) => db.delete(markets).where(eq(markets.id, id)))
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) throw new Error('Fixture market cleanup failed');
});

interface Fixtures {
  liveId: string;
  expiredId: string;
  resolvedId: string;
}

let fixtures: Fixtures | undefined;

// Newest createdAt values so the fixtures sit inside the first page of every
// list that sorts by createdAt desc.
async function seedFixtures(): Promise<Fixtures> {
  if (fixtures) return fixtures;
  const now = Date.now();
  const createdBase = new Date('2099-01-01T00:00:00.000Z').getTime();
  fixtures = {
    liveId: await insertMarket(
      'live',
      new Date(now + 60 * 60 * 1000),
      false,
      new Date(createdBase + 3000)
    ),
    expiredId: await insertMarket(
      'expired',
      new Date(now - 60 * 1000),
      false,
      new Date(createdBase + 2000)
    ),
    resolvedId: await insertMarket(
      'resolved',
      new Date(now - 60 * 1000),
      true,
      new Date(createdBase + 1000)
    ),
  };
  return fixtures;
}

function fixtureIdsIn(ids: string[], f: Fixtures): string[] {
  const mine = new Set([f.liveId, f.expiredId, f.resolvedId]);
  return ids.filter((id) => mine.has(id));
}

async function setEndDate(id: string, endDate: Date) {
  await db
    .update(markets)
    .set({ endDate, updatedAt: new Date() })
    .where(eq(markets.id, id));
}

describe('MCP market discovery excludes markets past their deadline', () => {
  it('get_markets lists the same fixture markets as the website list', async () => {
    const f = await seedFixtures();
    const adapter = new PredictionDbAdapter(db);

    const listed = await executeGetMarkets({ type: 'prediction' }, agent);
    const listedIds = fixtureIdsIn(
      listed.markets.map((m) => m.id),
      f
    );
    expect(listedIds).toEqual([f.liveId]);

    const websiteIds = fixtureIdsIn(
      (await adapter.listMarkets({ limit: 50 })).map((m) => m.id),
      f
    );
    expect(listedIds).toEqual(websiteIds);
  });

  it('get_system_stats stops counting a market once its deadline passes', async () => {
    const f = await seedFixtures();
    // Move one fixture across its deadline and measure the activeMarkets
    // delta between two reads. Only that update changes the open-market set
    // between the reads; the total market count is a control that detects a
    // concurrent insert or delete, in which case the pair is measured again.
    for (let attempt = 0; attempt < 3; attempt++) {
      await setEndDate(f.expiredId, new Date(Date.now() + 60 * 60 * 1000));
      const open = await executeGetSystemStats(agent, {});
      await setEndDate(f.expiredId, new Date(Date.now() - 60 * 1000));
      const closed = await executeGetSystemStats(agent, {});
      if (open.markets !== closed.markets) continue;
      expect(open.activeMarkets - closed.activeMarkets).toBe(1);
      return;
    }
    throw new Error('Market total kept changing; delta not measurable');
  });
});

describe('A2A market discovery excludes markets past their deadline', () => {
  it('markets.list_prediction status active lists only open fixture markets', async () => {
    const f = await seedFixtures();
    const raw = (await FeedAgentExecutor.executeDirectly(
      'markets.list_prediction',
      { status: 'active', limit: 50 },
      agent.userId
    )) as { predictions: Array<{ id: string }> };
    expect(
      fixtureIdsIn(
        raw.predictions.map((m) => m.id),
        f
      )
    ).toEqual([f.liveId]);
  });

  it('markets.list_prediction status resolved still lists resolved markets', async () => {
    const f = await seedFixtures();
    const raw = (await FeedAgentExecutor.executeDirectly(
      'markets.list_prediction',
      { status: 'resolved', limit: 50 },
      agent.userId
    )) as { predictions: Array<{ id: string }> };
    expect(
      fixtureIdsIn(
        raw.predictions.map((m) => m.id),
        f
      )
    ).toEqual([f.resolvedId]);
  });
});
