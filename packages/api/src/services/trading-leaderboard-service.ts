import { and, count, db, eq, like, not, users } from '@feed/db';
import type {
  LeaderboardEntry,
  LeaderboardPosition,
  LeaderboardResult,
  LeaderboardScope,
} from './leaderboard-types';
import {
  TradingPerformanceService,
  type WalletTradingPerformanceRow,
} from './trading-performance-service';

function mapWalletEntry(
  row: WalletTradingPerformanceRow,
  rank: number
): LeaderboardEntry {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    profileImageUrl: row.profileImageUrl,
    reputationPoints: Number(row.reputationPoints ?? 0),
    balance: Number(row.balance ?? 0),
    lifetimePnL: Number(row.lifetimePnL ?? 0),
    unrealizedPnL: Number(row.unrealizedPnL ?? 0),
    netProfit: Number(row.netProfit ?? 0),
    capitalBase: Number(row.capitalBase ?? 0),
    effectiveCapitalBase: Number(row.effectiveCapitalBase ?? 0),
    tradingReturn: Number(row.tradingReturn ?? 0),
    createdAt: new Date(row.createdAt),
    rank,
    isAgent: row.isAgent,
    managedBy: row.managedBy,
    nftTokenId: row.nftTokenId,
  };
}

/**
 * Board membership for the wallet trading leaderboard, mirroring the
 * fragment TradingPerformanceService applies to its row, entry, and
 * rank queries: actors, agents, test accounts (isTest flag or a
 * 'test-' id prefix), and banned accounts are not board members, so
 * the total count can never include accounts the rows exclude.
 */
function walletLeaderboardMembership() {
  return [
    eq(users.isActor, false),
    eq(users.isAgent, false),
    eq(users.isTest, false),
    eq(users.isBanned, false),
    not(like(users.id, 'test-%')),
  ];
}

export class TradingLeaderboardService {
  static async getWalletLeaderboard(
    page = 1,
    pageSize = 100
  ): Promise<LeaderboardResult> {
    const skip = (page - 1) * pageSize;

    const [countRows, rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(users)
        .where(and(...walletLeaderboardMembership())),
      TradingPerformanceService.getWalletLeaderboardRows(pageSize, skip),
    ]);

    const usersWithRank = rows.map((row, index) =>
      mapWalletEntry(row, skip + index + 1)
    );

    const totalCount = Number(countRows[0]?.count ?? 0);
    return {
      users: usersWithRank,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      leaderboardType: 'wallet',
      leaderboardMetric: 'trading',
    };
  }

  static async getUserPosition(
    userId: string,
    _leaderboardType: LeaderboardScope,
    pageSize = 100
  ): Promise<LeaderboardPosition | null> {
    const row = await TradingPerformanceService.getWalletEntry(userId);
    if (!row) return null;

    const higherCount = await TradingPerformanceService.countWalletsAbove({
      id: row.id,
      createdAt: row.createdAt,
      netProfit: row.netProfit,
    });

    const rank = higherCount + 1;
    return {
      rank,
      page: Math.ceil(rank / pageSize),
      entry: mapWalletEntry(row, rank),
    };
  }
}
