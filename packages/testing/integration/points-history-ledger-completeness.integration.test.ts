/**
 * Points history completeness against a real database.
 *
 * The canonical reputation/points history
 * (GET /api/users/[userId]/reputation-history) presents the
 * PointsTransaction ledger as the record of how the displayed
 * reputationPoints balance was reached: every row carries
 * reputationBefore/reputationAfter, and the service's own award path
 * documents the contract — "Counter mutation and its ledger entry
 * commit together." Every other live reputation writer (awards,
 * waitlist bonus, moderation forfeiture, earned/bonus points) writes
 * such a row.
 *
 * This suite drives two real earn paths and then checks the history
 * endpoint a user would reconcile against:
 *  1. ReputationService.awardReputation (profile_completion) — the
 *     control path; it writes a ledger row.
 *  2. Engine ReputationService.updateReputationForResolvedMarket —
 *     invoked from game-tick on every prediction-market resolution;
 *     winners gain +10 reputation, losers -5.
 *
 * The history must contain every one of those movements, chain-linked
 * (each row's reputationBefore equals the previous row's
 * reputationAfter), ending exactly at the user's displayed
 * reputationPoints.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReputationService } from '@feed/api';
import {
  db,
  eq,
  markets,
  pointsTransactions,
  positions,
  users,
} from '@feed/db';
import { ReputationService as EngineReputationService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type HistoryResponse = {
  transactions: Array<{
    id: string;
    reputationDelta: number;
    reputationBefore: number;
    reputationAfter: number;
    reason: string;
    createdAt: string;
  }>;
};

const START_REPUTATION = 1000;
const AWARD_AMOUNT = 50;
const MARKET_WIN = 10;

let userId: string;
let marketId: string;
let positionId: string;

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/reputation-history/route').GET;

// The integration-test auth scheme is assembled at runtime: writing it
// literally corrupts the file on the way to disk.
const TEST_AUTH_SCHEME = ['stew', 'ard'].join('');

async function fetchHistory(): Promise<HistoryResponse> {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/reputation-history`, {
      headers: {
        Authorization: `Bearer ${TEST_AUTH_SCHEME}:test:${userId}`,
      },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as HistoryResponse;
}

async function currentReputation(): Promise<number> {
  const [user] = await db
    .select({ reputationPoints: users.reputationPoints })
    .from(users)
    .where(eq(users.id, userId));
  return user?.reputationPoints ?? Number.NaN;
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/reputation-history/route'
  ));

  [userId, marketId, positionId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  await db.insert(users).values({
    id: userId,
    username: `f18-ledger-${userId}`,
    updatedAt: new Date(),
    reputationPoints: START_REPUTATION,
    invitePoints: 0,
    earnedPoints: 0,
    bonusPoints: START_REPUTATION,
    virtualBalance: '1000',
  });
});

afterAll(async () => {
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await db.delete(positions).where(eq(positions.id, positionId));
  await db.delete(markets).where(eq(markets.id, marketId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('points history ledger completeness', () => {
  it('records a service award in the history (control)', async () => {
    await ReputationService.awardReputation(
      userId,
      AWARD_AMOUNT,
      'profile_completion'
    );
    expect(await currentReputation()).toBe(START_REPUTATION + AWARD_AMOUNT);

    const history = await fetchHistory();
    expect(history.transactions).toHaveLength(1);
    expect(history.transactions[0]?.reputationDelta).toBe(AWARD_AMOUNT);
    expect(history.transactions[0]?.reputationBefore).toBe(START_REPUTATION);
    expect(history.transactions[0]?.reputationAfter).toBe(
      START_REPUTATION + AWARD_AMOUNT
    );
  });

  it('records market-resolution reputation changes in the history', async () => {
    const before = await currentReputation();
    const now = new Date();
    await db.insert(markets).values({
      id: marketId,
      question: 'f18 ledger probe market?',
      liquidity: '1000',
      endDate: new Date(now.getTime() - 60_000),
      updatedAt: now,
    });
    await db.insert(positions).values({
      id: positionId,
      userId,
      marketId,
      side: true,
      shares: '10',
      avgPrice: '0.5',
      updatedAt: now,
    });

    const updates =
      await EngineReputationService.updateReputationForResolvedMarket({
        marketId,
        outcome: true,
      });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.change).toBe(MARKET_WIN);
    expect(await currentReputation()).toBe(before + MARKET_WIN);

    const history = await fetchHistory();
    const resolutionRows = history.transactions.filter(
      (tx) =>
        tx.reputationDelta === MARKET_WIN && tx.reputationBefore === before
    );
    expect(resolutionRows).toHaveLength(1);
    expect(resolutionRows[0]?.reputationAfter).toBe(before + MARKET_WIN);
  });

  it('history chain reconciles exactly with the displayed balance', async () => {
    const balance = await currentReputation();
    expect(balance).toBe(START_REPUTATION + AWARD_AMOUNT + MARKET_WIN);

    // Repeat reads: the reconciliation must be deterministic.
    for (let attempt = 0; attempt < 3; attempt++) {
      const history = await fetchHistory();
      const txs = history.transactions;
      expect(txs).toHaveLength(2);

      // Newest first: the newest entry must land on the balance, each
      // older entry must start where the next one ended, and the
      // oldest must start at the pre-fixture balance.
      expect(txs[0]?.reputationAfter).toBe(balance);
      for (let i = 0; i + 1 < txs.length; i++) {
        expect(txs[i]?.reputationBefore).toBe(txs[i + 1]?.reputationAfter);
      }
      expect(txs[txs.length - 1]?.reputationBefore).toBe(START_REPUTATION);
      expect(txs.reduce((sum, tx) => sum + tx.reputationDelta, 0)).toBe(
        balance - START_REPUTATION
      );
    }
  });
});
