import 'server-only';

import { findUserByIdentifier } from '@feed/api';
import { calculatePredictionPositionSnapshot } from '@feed/core/markets/prediction';
import { asPublic, asUser, db } from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { toISO, toISOOrNull } from '@feed/shared';
import type {
  UserPerpPositionSnapshot,
  UserPositionsSnapshot,
  UserPositionsStatus,
  UserPositionsType,
} from './user-positions-types';

export {
  isOpenPredictionPosition,
  type UserPerpPositionSnapshot,
  type UserPositionsSnapshot,
  type UserPositionsStatus,
  type UserPositionsType,
  type UserPredictionPositionSnapshot,
} from './user-positions-types';

interface UserLookup {
  id: string;
  privyId: string | null;
}

interface ViewerDb {
  perpPosition: {
    findMany: typeof db.perpPosition.findMany;
  };
  position: {
    findMany: typeof db.position.findMany;
  };
  market: {
    findMany: typeof db.market.findMany;
  };
}
async function getCanonicalUser(userId: string): Promise<UserLookup | null> {
  return findUserByIdentifier(userId, {
    id: true,
    privyId: true,
  });
}

async function readWithViewer<T>({
  viewerUserId,
  operation,
}: {
  viewerUserId?: string | null;
  operation: (database: ViewerDb) => Promise<T>;
}): Promise<T> {
  if (viewerUserId) {
    return asUser(viewerUserId, operation);
  }

  return asPublic(operation);
}

async function loadDbPerpPositions(params: {
  viewerUserId?: string | null;
  canonicalUserId: string;
  positionUserIds: string[];
  closedAtFilter:
    | {
        not: null;
      }
    | undefined
    | null;
}): Promise<UserPerpPositionSnapshot[]> {
  const { viewerUserId, canonicalUserId, positionUserIds, closedAtFilter } =
    params;

  const perpWhereBase = {
    userId:
      positionUserIds.length === 1 ? canonicalUserId : { in: positionUserIds },
    ...(closedAtFilter !== undefined ? { closedAt: closedAtFilter } : {}),
  };

  const positions = await readWithViewer({
    viewerUserId,
    operation: async (database) => {
      return database.perpPosition.findMany({ where: perpWhereBase });
    },
  });

  return positions.map((position) => ({
    id: position.id,
    ticker: position.ticker,
    side: position.side.toLowerCase() as 'long' | 'short',
    entryPrice: Number(position.entryPrice),
    currentPrice: Number(position.currentPrice),
    size: Number(position.size),
    leverage: Number(position.leverage),
    unrealizedPnL: Number(position.unrealizedPnL),
    unrealizedPnLPercent: Number(position.unrealizedPnLPercent),
    liquidationPrice: Number(position.liquidationPrice),
    fundingPaid: Number(position.fundingPaid),
    realizedPnL: Number((position as Record<string, unknown>).realizedPnL ?? 0),
    openedAt: toISO(position.openedAt),
    closedAt: toISOOrNull(position.closedAt),
  }));
}

export async function getUserPositionsSnapshot({
  userId,
  type = 'all',
  status = 'open',
  page = 1,
  limit = 20,
  viewerUserId,
}: {
  userId: string;
  type?: UserPositionsType;
  status?: UserPositionsStatus;
  page?: number;
  limit?: number;
  viewerUserId?: string | null;
}): Promise<UserPositionsSnapshot> {
  const dbUser = await getCanonicalUser(userId);
  const canonicalUserId = dbUser?.id ?? userId;
  const positionUserIds = dbUser
    ? [
        ...new Set(
          [dbUser.id, dbUser.privyId].filter((candidate): candidate is string =>
            Boolean(candidate)
          )
        ),
      ]
    : [userId];

  const closedAtFilter =
    status === 'closed' ? { not: null } : status === 'all' ? undefined : null;
  // Open prediction positions are exactly the 'active' ones; resolved or
  // closed positions belong to the closed view.
  const predictionStatusFilter =
    status === 'closed'
      ? { in: ['closed', 'resolved'] }
      : status === 'open'
        ? 'active'
        : undefined;
  const includePerps = type !== 'prediction';
  const includePredictions = type !== 'perp';

  const predictionWhereBase = {
    userId:
      positionUserIds.length === 1 ? canonicalUserId : { in: positionUserIds },
    ...(predictionStatusFilter ? { status: predictionStatusFilter } : {}),
  };
  const mappedPerps = includePerps
    ? await loadDbPerpPositions({
        viewerUserId,
        canonicalUserId,
        positionUserIds,
        closedAtFilter,
      })
    : [];

  // type=perp must not load (or fail on) prediction positions.
  const predictionPositions = includePredictions
    ? await readWithViewer({
        viewerUserId,
        operation: async (database) => {
          return database.position.findMany({ where: predictionWhereBase });
        },
      })
    : [];

  const marketIds = [
    ...new Set(predictionPositions.map((position) => position.marketId)),
  ];
  const markets =
    marketIds.length > 0
      ? await readWithViewer({
          viewerUserId,
          operation: async (database) => {
            return database.market.findMany({
              where: {
                id: { in: marketIds },
              },
              select: {
                id: true,
                question: true,
                endDate: true,
                resolved: true,
                resolution: true,
                yesShares: true,
                noShares: true,
              },
            });
          },
        })
      : [];

  const marketById = new Map(markets.map((market) => [market.id, market]));

  const mappedPredictions = predictionPositions
    .map((position) => {
      const market = marketById.get(position.marketId);
      if (!market) {
        throw new Error(
          `Missing market ${position.marketId} for position ${position.id}`
        );
      }

      const shares = Number(position.shares);
      const avgPrice = Number(position.avgPrice);
      const side = position.side ? 'yes' : 'no';
      const snapshot = calculatePredictionPositionSnapshot({
        shares,
        avgPrice,
        side,
        yesShares: Number(market.yesShares),
        noShares: Number(market.noShares),
        feeRate: FEE_CONFIG.TRADING_FEE_RATE,
        resolved: market.resolved,
        resolution: market.resolution,
      });

      return {
        id: position.id,
        marketId: position.marketId,
        question: market.question,
        side: (position.side ? 'YES' : 'NO') as 'YES' | 'NO',
        shares,
        avgPrice,
        currentPrice: snapshot.currentUnitPrice,
        currentProbability: snapshot.currentProbability,
        currentValue: snapshot.currentValue,
        costBasis: snapshot.costBasis,
        unrealizedPnL: snapshot.unrealizedPnL,
        resolved: market.resolved,
        resolution: market.resolution,
        closesAt: toISOOrNull(market.endDate),
        status: position.status as string,
        createdAt: toISOOrNull(position.createdAt),
        outcome: position.outcome ?? null,
        pnl: position.pnl == null ? null : Number(position.pnl),
        resolvedAt: toISOOrNull(position.resolvedAt),
      };
    })
    .filter((position) => position.shares >= 0.01);

  const perpStats = {
    totalPositions: mappedPerps.length,
    totalPnL: mappedPerps.reduce(
      (sum, position) => sum + position.unrealizedPnL,
      0
    ),
    totalFunding: mappedPerps.reduce(
      (sum, position) => sum + position.fundingPaid,
      0
    ),
  };

  const filteredPerps = type === 'prediction' ? [] : mappedPerps;
  const filteredPredictions = type === 'perp' ? [] : mappedPredictions;

  if (status === 'closed') {
    filteredPerps.sort(
      (left, right) =>
        new Date(right.closedAt ?? 0).getTime() -
        new Date(left.closedAt ?? 0).getTime()
    );
    filteredPredictions.sort(
      (left, right) =>
        new Date(right.resolvedAt ?? right.createdAt ?? 0).getTime() -
        new Date(left.resolvedAt ?? left.createdAt ?? 0).getTime()
    );
  }

  // Only the closed view is paginated; open/all views return everything.
  const isPaginated = status === 'closed';
  const paginatedPerps = isPaginated
    ? filteredPerps.slice((page - 1) * limit, page * limit)
    : filteredPerps;
  const paginatedPredictions = isPaginated
    ? filteredPredictions.slice((page - 1) * limit, page * limit)
    : filteredPredictions;

  return {
    perpetuals: {
      positions: paginatedPerps,
      stats:
        type === 'prediction'
          ? { totalPositions: 0, totalPnL: 0, totalFunding: 0 }
          : perpStats,
      total: filteredPerps.length,
      hasMore: isPaginated && page * limit < filteredPerps.length,
    },
    predictions: {
      positions: paginatedPredictions,
      stats: {
        totalPositions: filteredPredictions.length,
      },
      total: filteredPredictions.length,
      hasMore: isPaginated && page * limit < filteredPredictions.length,
    },
    timestamp: new Date().toISOString(),
  };
}
