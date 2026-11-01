/**
 * Integration Test: prediction market concurrency primitives
 *
 * The unit suite proves the service logic against an in-memory double. These
 * tests run the two conditional UPDATE ... RETURNING statements against a real
 * Postgres so the arbitration the fix relies on is verified where it matters:
 * two concurrent claims, exactly one winner.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { PredictionDbAdapter } from '@feed/core';
import { db, questions } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const adapter = new PredictionDbAdapter(db);
const created: { marketIds: string[]; positionIds: string[] } = {
  marketIds: [],
  positionIds: [],
};

let nextQuestionNumber = 900_000 + Math.floor(Math.random() * 90_000);

async function newMarket(liquidity = 1_000): Promise<string> {
  const id = await generateSnowflakeId();
  const resolutionDate = new Date(Date.now() + 86_400_000);
  await db.insert(questions).values({
    id,
    questionNumber: nextQuestionNumber++,
    text: `concurrency ${id}`,
    scenarioId: 1,
    outcome: true,
    rank: 1,
    resolutionDate,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await adapter.createMarketFromQuestion(
    { id, text: `concurrency ${id}`, status: 'active', resolutionDate },
    liquidity
  );
  created.marketIds.push(id);
  return id;
}

async function newPosition(
  marketId: string,
  shares: number,
  side: 'yes' | 'no' = 'yes'
): Promise<string> {
  const position = await adapter.upsertPosition({
    marketId,
    userId: `user-${await generateSnowflakeId()}`,
    side,
    shares,
    avgPrice: 0.5,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  created.positionIds.push(position.id);
  return position.id;
}

afterAll(async () => {
  const { inArray } = await import('drizzle-orm');
  const { positions, markets } = await import('@feed/db');
  if (created.positionIds.length) {
    await db
      .delete(positions)
      .where(inArray(positions.id, created.positionIds));
  }
  if (created.marketIds.length) {
    await db.delete(markets).where(inArray(markets.id, created.marketIds));
  }
});

describe('prediction concurrency on real Postgres', () => {
  test('two concurrent share claims: exactly one wins', async () => {
    const marketId = await newMarket();
    const positionId = await newPosition(marketId, 100);

    const [first, second] = await Promise.all([
      adapter.claimPositionShares(positionId, 100),
      adapter.claimPositionShares(positionId, 100),
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(Number(winners[0]?.shares)).toBe(0);
  });

  test('a partial claim leaves the remainder claimable and the rest refused', async () => {
    const marketId = await newMarket();
    const positionId = await newPosition(marketId, 100);

    const first = await adapter.claimPositionShares(positionId, 60);
    expect(first).not.toBeNull();
    expect(Number(first?.shares)).toBe(40);

    const overdraw = await adapter.claimPositionShares(positionId, 60);
    expect(overdraw).toBeNull();

    const rest = await adapter.claimPositionShares(positionId, 40);
    expect(rest).not.toBeNull();
    expect(Number(rest?.shares)).toBe(0);
  });

  test('two concurrent resolutions: exactly one wins', async () => {
    const marketId = await newMarket();

    const [first, second] = await Promise.all([
      adapter.claimResolution(marketId, { resolution: true, liquidity: 900 }),
      adapter.claimResolution(marketId, { resolution: false, liquidity: 800 }),
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.resolved).toBe(true);

    const after = await adapter.claimResolution(marketId, { liquidity: 1 });
    expect(after).toBeNull();
  });
});
