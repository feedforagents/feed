/**
 * Reputation Service (Engine)
 *
 * Tracks prediction market outcomes in the local database.
 * Winners get +10 reputation points, losers get -5.
 *
 * On-chain reputation tracking via Base Sepolia contracts has been removed.
 * Reputation is now purely database-driven, with optional Agent0 feedback
 * propagation handled by the ReputationBridge in @feed/agents.
 */

import {
  db,
  eq,
  inArray,
  pointsTransactions,
  positions,
  users,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';

// =============================================================================
// Reputation Sync Interface
// =============================================================================

export interface ReputationSyncResult {
  synced: number;
  failed: number;
  total: number;
  skipped?: number;
}

export interface ReputationSyncOptions {
  limit?: number;
  offset?: number;
  forceRecalculate?: boolean;
  prioritizeNew?: boolean;
}

export interface ReputationSyncServiceInterface {
  batchSync(options?: ReputationSyncOptions): Promise<ReputationSyncResult>;
}

let reputationSyncService: ReputationSyncServiceInterface | null = null;

export function setReputationSyncService(
  service: ReputationSyncServiceInterface | null
): void {
  reputationSyncService = service;
}

export function getReputationSyncService(): ReputationSyncServiceInterface | null {
  return reputationSyncService;
}

export async function syncReputationIfAvailable(
  options?: ReputationSyncOptions
): Promise<ReputationSyncResult | null> {
  if (!reputationSyncService) return null;
  return await reputationSyncService.batchSync(options);
}

interface MarketResolution {
  marketId: string;
  outcome: boolean;
}

interface ReputationUpdate {
  userId: string;
  tokenId: number;
  change: number;
  txHash?: string;
  error?: string;
}

export class ReputationService {
  static async updateReputationForResolvedMarket(
    resolution: MarketResolution
  ): Promise<ReputationUpdate[]> {
    const results: ReputationUpdate[] = [];

    const positionsData = await db
      .select({
        id: positions.id,
        userId: positions.userId,
        side: positions.side,
        shares: positions.shares,
      })
      .from(positions)
      .where(eq(positions.marketId, resolution.marketId));

    if (positionsData.length === 0) {
      logger.info(
        `No positions found for market ${resolution.marketId}`,
        undefined,
        'ReputationService'
      );
      return [];
    }

    const userIds = [...new Set(positionsData.map((p) => p.userId))];
    const usersData = await db
      .select({
        id: users.id,
        nftTokenId: users.nftTokenId,
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userMap = new Map(usersData.map((u) => [u.id, u]));

    logger.info(
      `Updating reputation for ${positionsData.length} positions in market ${resolution.marketId}`,
      { count: positionsData.length, marketId: resolution.marketId },
      'ReputationService'
    );

    for (const position of positionsData) {
      const user = userMap.get(position.userId);
      if (!user) {
        results.push({
          userId: position.userId,
          tokenId: 0,
          change: 0,
          error: 'User not found',
        });
        continue;
      }

      const tokenId = user.nftTokenId ?? 0;
      const isWinner = position.side === resolution.outcome;
      const change = isWinner ? 10 : -5;

      // The counter mutation and its PointsTransaction ledger entry
      // commit together, as in every other reputation writer: the
      // points history presents that ledger as the record of how the
      // displayed reputationPoints balance was reached, so a change
      // without an entry leaves the history unable to explain the
      // balance. The row is re-read under a lock because one user can
      // hold several positions in the same market.
      const newReputation = await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select({ reputationPoints: users.reputationPoints })
          .from(users)
          .where(eq(users.id, position.userId))
          .limit(1)
          .for('update');

        if (!fresh) {
          return null;
        }

        const pointsBefore = fresh.reputationPoints ?? 0;
        const pointsAfter = Math.max(0, pointsBefore + change);
        const actualChange = pointsAfter - pointsBefore;

        await tx
          .update(users)
          .set({ reputationPoints: pointsAfter, updatedAt: new Date() })
          .where(eq(users.id, position.userId));

        if (actualChange !== 0) {
          await tx.insert(pointsTransactions).values({
            id: await generateSnowflakeId(),
            userId: position.userId,
            amount: actualChange,
            pointsBefore,
            pointsAfter,
            reason: 'market_resolution',
            metadata: JSON.stringify({
              marketId: resolution.marketId,
              outcome: resolution.outcome,
              side: position.side,
            }),
          });
        }

        return pointsAfter;
      });

      results.push({
        userId: position.userId,
        tokenId,
        change,
      });

      logger.info(
        `Updated reputation for user ${position.userId}`,
        { tokenId, change, newReputation: newReputation ?? undefined },
        'ReputationService'
      );
    }

    return results;
  }

  static async getOnChainReputation(userId: string): Promise<number | null> {
    const [user] = await db
      .select({
        reputationPoints: users.reputationPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    return user.reputationPoints ?? null;
  }

  static async syncUserReputation(userId: string): Promise<number | null> {
    return ReputationService.getOnChainReputation(userId);
  }

  static async batchUpdateReputation(
    resolutions: MarketResolution[]
  ): Promise<Record<string, ReputationUpdate[]>> {
    const allResults: Record<string, ReputationUpdate[]> = {};

    for (const resolution of resolutions) {
      const results =
        await ReputationService.updateReputationForResolvedMarket(resolution);
      allResults[resolution.marketId] = results;
    }

    return allResults;
  }
}
