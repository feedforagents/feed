/**
 * Integration test: market-resolution reputation must only reward holders.
 *
 * `ReputationService.updateReputationForResolvedMarket` sweeps every position
 * row for the market, including rows with zero shares — users who sold out
 * entirely before resolution. `PredictionMarketService.resolve` marks even
 * those closed rows `resolved` (it iterates all positions for the market), so
 * the sweep awards the ex-holder +10 on the winning side or -5 on the losing
 * side even though they held nothing at resolution.
 *
 * Runs against a real Postgres database (DATABASE_URL).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db, eq, positions, users } from '@feed/db';
import { ReputationService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

describe('ReputationService - resolved-market reputation', () => {
  const MARKET_ID = `test-rep-market-${Date.now()}`;
  const STARTING_REPUTATION = 100;

  let winnerId: string;
  let loserId: string;
  let winningExHolderId: string;
  let losingExHolderId: string;

  async function reputationOf(userId: string): Promise<number> {
    const [row] = await db
      .select({ reputationPoints: users.reputationPoints })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.reputationPoints ?? -1;
  }

  beforeAll(async () => {
    winnerId = await generateSnowflakeId();
    loserId = await generateSnowflakeId();
    winningExHolderId = await generateSnowflakeId();
    losingExHolderId = await generateSnowflakeId();
    const now = new Date();

    await db.insert(users).values([
      {
        id: winnerId,
        username: `rep-winner-${winnerId.slice(-8)}`,
        reputationPoints: STARTING_REPUTATION,
        updatedAt: now,
      },
      {
        id: loserId,
        username: `rep-loser-${loserId.slice(-8)}`,
        reputationPoints: STARTING_REPUTATION,
        updatedAt: now,
      },
      {
        id: winningExHolderId,
        username: `rep-exwin-${winningExHolderId.slice(-8)}`,
        reputationPoints: STARTING_REPUTATION,
        updatedAt: now,
      },
      {
        id: losingExHolderId,
        username: `rep-exlose-${losingExHolderId.slice(-8)}`,
        reputationPoints: STARTING_REPUTATION,
        updatedAt: now,
      },
    ]);

    // Post-resolution state: resolve() marks every position for the market
    // `resolved`, including rows the user fully sold out of (shares 0).
    await db.insert(positions).values([
      {
        id: await generateSnowflakeId(),
        userId: winnerId,
        marketId: MARKET_ID,
        side: true,
        shares: '10',
        avgPrice: '0.5',
        status: 'resolved',
        outcome: true,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: await generateSnowflakeId(),
        userId: loserId,
        marketId: MARKET_ID,
        side: false,
        shares: '5',
        avgPrice: '0.5',
        status: 'resolved',
        outcome: false,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: await generateSnowflakeId(),
        userId: winningExHolderId,
        marketId: MARKET_ID,
        side: true,
        shares: '0',
        avgPrice: '0.5',
        status: 'resolved',
        outcome: true,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: await generateSnowflakeId(),
        userId: losingExHolderId,
        marketId: MARKET_ID,
        side: false,
        shares: '0',
        avgPrice: '0.5',
        status: 'resolved',
        outcome: false,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(positions).where(eq(positions.marketId, MARKET_ID));
    for (const userId of [
      winnerId,
      loserId,
      winningExHolderId,
      losingExHolderId,
    ]) {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  test('holders gain/lose reputation, zero-share ex-holders do not', async () => {
    await ReputationService.updateReputationForResolvedMarket({
      marketId: MARKET_ID,
      outcome: true,
    });

    expect(await reputationOf(winnerId)).toBe(STARTING_REPUTATION + 10);
    expect(await reputationOf(loserId)).toBe(STARTING_REPUTATION - 5);
    expect(await reputationOf(winningExHolderId)).toBe(STARTING_REPUTATION);
    expect(await reputationOf(losingExHolderId)).toBe(STARTING_REPUTATION);
  });
});
