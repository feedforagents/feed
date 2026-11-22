/**
 * PRD §8.1/§9.2, MVP Phase 6: MCP market discovery offers the same open
 * markets as the website trading list. A market past its deadline stays
 * unresolved until settlement runs, but it is closed for trading, so
 * get_markets must not list it and get_system_stats must not count it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { PredictionDbAdapter } from '@feed/core/markets/prediction';
import { dbWrite as db, eq, markets } from '@feed/db';
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

describe('MCP market discovery excludes markets past their deadline', () => {
  it('lists and counts only markets the website trading list offers', async () => {
    const adapter = new PredictionDbAdapter(db);
    const statsBefore = await executeGetSystemStats(agent, {});
    expect(statsBefore.activeMarkets).toBe(
      await adapter.countUnresolvedMarkets()
    );

    const now = Date.now();
    // Newest createdAt values so the fixtures sit inside the 50-row page.
    const createdBase = new Date('2099-01-01T00:00:00.000Z').getTime();
    const liveId = await insertMarket(
      'live',
      new Date(now + 60 * 60 * 1000),
      false,
      new Date(createdBase + 3000)
    );
    const expiredId = await insertMarket(
      'expired',
      new Date(now - 60 * 1000),
      false,
      new Date(createdBase + 2000)
    );
    const resolvedId = await insertMarket(
      'resolved',
      new Date(now - 60 * 1000),
      true,
      new Date(createdBase + 1000)
    );

    const listed = await executeGetMarkets({ type: 'prediction' }, agent);
    const listedIds = listed.markets.map((m) => m.id);
    expect(listedIds).toContain(liveId);
    expect(listedIds).not.toContain(expiredId);
    expect(listedIds).not.toContain(resolvedId);

    const websiteIds = (await adapter.listMarkets({ limit: 50 })).map(
      (m) => m.id
    );
    expect(listedIds).toEqual(websiteIds);

    const statsAfter = await executeGetSystemStats(agent, {});
    expect(statsAfter.activeMarkets).toBe(statsBefore.activeMarkets + 1);
    expect(statsAfter.activeMarkets).toBe(
      await adapter.countUnresolvedMarkets()
    );
  });
});
