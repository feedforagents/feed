/**
 * Integration Tests: Trading Leaderboard Membership (PRD §9.4, D-15b)
 *
 * The trading leaderboard is the PRD §9.4 board: players ranked by net
 * profit. Every other user-facing list in the codebase ranks and counts
 * one membership — not a test account (isTest flag or a 'test-' id) and
 * not banned — applied before count and paging so totals, pages, and
 * positions measure the same membership (see the followers list and the
 * A2A people search). On base the trading board's list, total count, and
 * position lookup filter only actors/agents, so test and banned accounts
 * hold the top ranks, inflate the total, and push every real player's
 * rank down.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'trading leaderboard membership';
const cases = {
  population:
    'test and banned accounts are not ranked and do not inflate the total',
  top: 'a real player position is not pushed down by hidden accounts',
  banned: 'a banned account has no position on the board',
  eligible: 'the eligible population is unchanged for ordinary players',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks trading leaderboard membership in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'trading-leaderboard-membership',
      file: 'packages/testing/integration/trading-leaderboard-membership.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { TradingLeaderboardService } = await import(
    '@feed/api/services/trading-leaderboard-service'
  );
  const { db, eq, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');

  const suffix = crypto.randomUUID().slice(0, 8);

  const ids = {
    visibleTop: '',
    visibleSecond: '',
    testFlag: '',
    testId: `test-lb192-${suffix}`,
    banned: '',
  };
  async function createUser(params: {
    id?: string;
    lifetimePnL: number;
    isTest?: boolean;
    isBanned?: boolean;
    createdAt: Date;
  }): Promise<string> {
    const id = params.id ?? (await generateSnowflakeId());
    await db.insert(users).values({
      id,
      privyId: `did:privy:lb192-${id}`,
      username: `lb192-${id}`,
      displayName: 'lb192',
      virtualBalance: '1000',
      totalDeposited: '1000',
      totalWithdrawn: '0',
      lifetimePnL: params.lifetimePnL.toFixed(2),
      reputationPoints: 0,
      isActor: false,
      isAgent: false,
      isTest: params.isTest ?? false,
      isBanned: params.isBanned ?? false,
      profileComplete: true,
      createdAt: params.createdAt,
      updatedAt: new Date(),
    });
    return id;
  }

  beforeAll(async () => {
    const t = (seconds: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
    ids.testFlag = await createUser({
      lifetimePnL: 999_999,
      isTest: true,
      createdAt: t(1),
    });
    await createUser({
      id: ids.testId,
      lifetimePnL: 888_888,
      createdAt: t(2),
    });
    ids.banned = await createUser({
      lifetimePnL: 777_777,
      isBanned: true,
      createdAt: t(3),
    });
    ids.visibleTop = await createUser({ lifetimePnL: 5_000, createdAt: t(4) });
    ids.visibleSecond = await createUser({
      lifetimePnL: 3_000,
      createdAt: t(5),
    });
  });

  describe(suite, () => {
    test(cases.population, async () => {
      const board = await TradingLeaderboardService.getWalletLeaderboard(
        1,
        100
      );
      const rankedIds = board.users.map((entry) => entry.id);

      expect(rankedIds).not.toContain(ids.testFlag);
      expect(rankedIds).not.toContain(ids.testId);
      expect(rankedIds).not.toContain(ids.banned);

      const top = board.users.find((entry) => entry.id === ids.visibleTop);
      const second = board.users.find(
        (entry) => entry.id === ids.visibleSecond
      );
      expect(top?.rank).toBe(1);
      expect(second?.rank).toBe(2);

      // The disposable database holds only these fixtures, so the total is
      // the eligible membership: the two visible players.
      expect(board.totalCount).toBe(2);
    });

    test(cases.top, async () => {
      const position = await TradingLeaderboardService.getUserPosition(
        ids.visibleTop,
        'wallet'
      );
      expect(position?.rank).toBe(1);
    });

    test(cases.banned, async () => {
      const position = await TradingLeaderboardService.getUserPosition(
        ids.banned,
        'wallet'
      );
      expect(position).toBeNull();
    });

    test(cases.eligible, async () => {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, ids.visibleSecond));
      expect(row?.id).toBe(ids.visibleSecond);

      const position = await TradingLeaderboardService.getUserPosition(
        ids.visibleSecond,
        'wallet'
      );
      expect(position?.rank).toBe(2);
    });
  });
}
