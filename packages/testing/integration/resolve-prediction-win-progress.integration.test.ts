/**
 * Admin market resolution must advance winners' reward progress.
 *
 * The rewards page reads challenge progress from live state: the weekly
 * win challenges (weekly_two_wins, weekly_positive_pnl) count resolved
 * positions with outcome = true, so after an admin resolves a market the
 * page shows the winner at full progress. Completion and the reputation
 * payout, however, only happen inside checkProgress('prediction_win'),
 * which the markets-tick cron fires for the markets it resolves itself.
 * The two admin resolution paths — the web admin route and the MCP
 * resolve_market tool — settle the same markets without firing it, so
 * their winners stay at "progress full, never completed, never paid"
 * forever, and the always-on First Win achievement never unlocks either.
 *
 * This suite resolves real markets through both admin paths against a
 * real database and asserts the progress effects the cron path produces:
 * the First Win unlock, its points-ledger credit, and — in weeks where a
 * win-based weekly challenge is active — that challenge's completion and
 * ledger credit. A losing position holder is the negative control.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getActiveWeeklyChallengeIds, getUserChallenges } from '@feed/api';
import {
  and,
  db,
  eq,
  markets,
  pointsTransactions,
  positions,
  questions,
  userAchievements,
  userChallengeProgress,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeResolveMarket } from '../../mcp/src/handlers/tool-handlers';

// The web admin route authenticates through the CI admin-token path.
(process.env as Record<string, string>).CI = 'true';
(process.env as Record<string, string>).CI_ADMIN_TOKEN = 'f52-ci-admin-token';
(process.env as Record<string, string>).DISABLE_RATE_LIMITING = 'true';

type AdminRoute =
  typeof import('../../../apps/web/src/app/api/admin/markets/[marketId]/route');
let adminRoute: AdminRoute;

const FIRST_WIN_POINTS = 150;
const WEEKLY_TWO_WINS_POINTS = 180;
const WEEKLY_POSITIVE_PNL_POINTS = 180;

let mcpAdminId: string;
let winnerMcpId: string;
let loserMcpId: string;
let winnerWebId: string;
let mcpMarket1: string;
let mcpMarket2: string;
let webMarket: string;

async function seedUser(isAdmin = false): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `f52_${id.slice(-10)}`,
    isActor: false,
    isAdmin,
    updatedAt: new Date(),
  });
  return id;
}

async function seedMarket(questionText: string): Promise<string> {
  const id = await generateSnowflakeId();
  const endDate = new Date(Date.now() + 86_400_000);
  await db.insert(markets).values({
    id,
    question: questionText,
    yesShares: '500',
    noShares: '500',
    liquidity: '1000',
    endDate,
    updatedAt: new Date(),
  });
  await db.insert(questions).values({
    id,
    questionNumber: 1_800_000_000 + (Date.now() % 100_000_000),
    marketId: id,
    text: questionText,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    resolutionDate: endDate,
    status: 'active',
    updatedAt: new Date(),
  });
  return id;
}

async function seedPosition(
  userId: string,
  marketId: string,
  side: boolean
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(positions).values({
    id,
    userId,
    marketId,
    side,
    shares: '100',
    avgPrice: '0.5',
    amount: '50',
    status: 'active',
    updatedAt: new Date(),
  });
  return id;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 9000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function firstWinRow(userId: string) {
  const rows = await db
    .select()
    .from(userAchievements)
    .where(
      and(
        eq(userAchievements.userId, userId),
        eq(userAchievements.achievementId, 'first_win')
      )
    );
  return rows[0] ?? null;
}

async function ledgerRows(userId: string, reason: string) {
  return db
    .select()
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.userId, userId),
        eq(pointsTransactions.reason, reason)
      )
    );
}

async function challengeRow(userId: string, challengeId: string) {
  const rows = await db
    .select()
    .from(userChallengeProgress)
    .where(
      and(
        eq(userChallengeProgress.userId, userId),
        eq(userChallengeProgress.challengeId, challengeId)
      )
    );
  return rows[0] ?? null;
}

/** Assertions shared by both admin resolution paths. */
async function expectWinProgressCredited(
  winnerId: string,
  wins: number
): Promise<void> {
  // The always-on First Win achievement unlocks and pays 150 into the
  // points ledger — the observable proof the prediction_win check ran.
  const unlock = await waitFor('first_win unlock', () => firstWinRow(winnerId));
  expect(unlock.pointsAwarded).toBe(FIRST_WIN_POINTS);

  const unlockLedger = await ledgerRows(winnerId, 'achievement_unlock');
  expect(unlockLedger.map((r) => r.amount)).toContain(FIRST_WIN_POINTS);

  const [winner] = await db
    .select({ reputationPoints: users.reputationPoints })
    .from(users)
    .where(eq(users.id, winnerId));
  expect(winner!.reputationPoints).toBeGreaterThanOrEqual(FIRST_WIN_POINTS);

  // Win-based weekly challenges complete in the weeks they are active.
  const activeWeekly = getActiveWeeklyChallengeIds();
  if (activeWeekly.includes('weekly_positive_pnl')) {
    const row = await waitFor('weekly_positive_pnl completion', async () => {
      const r = await challengeRow(winnerId, 'weekly_positive_pnl');
      return r?.completed === 1 ? r : null;
    });
    expect(row.pointsAwarded).toBe(WEEKLY_POSITIVE_PNL_POINTS);
    const challengeLedger = await ledgerRows(winnerId, 'challenge_complete');
    expect(challengeLedger.map((r) => r.amount)).toContain(
      WEEKLY_POSITIVE_PNL_POINTS
    );
  }
  if (wins >= 2 && activeWeekly.includes('weekly_two_wins')) {
    const row = await waitFor('weekly_two_wins completion', async () => {
      const r = await challengeRow(winnerId, 'weekly_two_wins');
      return r?.completed === 1 ? r : null;
    });
    expect(row.pointsAwarded).toBe(WEEKLY_TWO_WINS_POINTS);

    // The rewards page itself must report the challenge completed, not
    // merely at full progress.
    const challenges = await getUserChallenges(winnerId);
    const shown = challenges.weekly.challenges.find(
      (c) => c.id === 'weekly_two_wins'
    );
    expect(shown?.progress).toBe(2);
    expect(shown?.completed).toBe(true);
  }
}

describe('admin resolution advances winners reward progress', () => {
  beforeAll(async () => {
    adminRoute = await import(
      '../../../apps/web/src/app/api/admin/markets/[marketId]/route'
    );

    mcpAdminId = await seedUser(true);
    winnerMcpId = await seedUser();
    loserMcpId = await seedUser();
    winnerWebId = await seedUser();

    mcpMarket1 = await seedMarket('F52 MCP market one?');
    mcpMarket2 = await seedMarket('F52 MCP market two?');
    webMarket = await seedMarket('F52 web-admin market?');

    await seedPosition(winnerMcpId, mcpMarket1, true);
    await seedPosition(winnerMcpId, mcpMarket2, true);
    await seedPosition(loserMcpId, mcpMarket1, false);
    await seedPosition(winnerWebId, webMarket, true);
  });

  afterAll(async () => {
    const marketIds = [mcpMarket1, mcpMarket2, webMarket];
    const userIds = [mcpAdminId, winnerMcpId, loserMcpId, winnerWebId];
    for (const marketId of marketIds) {
      await db.delete(positions).where(eq(positions.marketId, marketId));
      await db.delete(questions).where(eq(questions.id, marketId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
    for (const userId of userIds) {
      await db
        .delete(userChallengeProgress)
        .where(eq(userChallengeProgress.userId, userId));
      await db
        .delete(userAchievements)
        .where(eq(userAchievements.userId, userId));
      await db
        .delete(pointsTransactions)
        .where(eq(pointsTransactions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('settles winners through MCP resolve_market and credits their win progress', async () => {
    const agent = { agentId: 'f52-agent', userId: mcpAdminId } as Parameters<
      typeof executeResolveMarket
    >[0];

    const first = await executeResolveMarket(agent, {
      marketId: mcpMarket1,
      resolution: true,
    });
    expect(first.success).toBe(true);
    const second = await executeResolveMarket(agent, {
      marketId: mcpMarket2,
      resolution: true,
    });
    expect(second.success).toBe(true);

    // Settlement itself happened: the winning positions are resolved wins.
    const settled = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, winnerMcpId));
    expect(settled).toHaveLength(2);
    for (const p of settled) {
      expect(p.outcome).toBe(true);
      expect(p.resolvedAt).not.toBeNull();
    }

    await expectWinProgressCredited(winnerMcpId, 2);

    // Negative control: the losing holder got no win progress at all.
    expect(await firstWinRow(loserMcpId)).toBeNull();
    expect(await ledgerRows(loserMcpId, 'achievement_unlock')).toHaveLength(0);
  });

  it('settles winners through the web admin route and credits their win progress', async () => {
    const { NextRequest } = await import('next/server');
    const request = new NextRequest(
      `http://localhost/api/admin/markets/${webMarket}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dev-admin-token': 'f52-ci-admin-token',
        },
        body: JSON.stringify({ action: 'resolve', resolution: true }),
      }
    );
    const response = await adminRoute.POST(request, {
      params: Promise.resolve({ marketId: webMarket }),
    });
    expect(response.status).toBe(200);

    const settled = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, winnerWebId));
    expect(settled).toHaveLength(1);
    expect(settled[0]!.outcome).toBe(true);
    expect(settled[0]!.resolvedAt).not.toBeNull();

    await expectWinProgressCredited(winnerWebId, 1);
  });
});
