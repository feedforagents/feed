import {
  and,
  balanceTransactions as balanceTransactionsTable,
  dbRead,
  eq,
  inArray,
  npcTrades as npcTradesTable,
  or,
  perpPositions as perpPositionsTable,
  sql,
  users as usersTable,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';

type TradePageKey = { kind: 'balance' | 'npc' | 'perp'; id: string };

/** Existing public trade history: select eligible keys before paging/hydration. */
export async function getTradesFeed(params: {
  limit: number;
  offset: number;
  userId?: string;
}) {
  const actors = StaticDataRegistry.getAllActors();
  // getActor matches exact IDs, then case-insensitive usernames. Keep both
  // domains without making IDs themselves case-insensitive.
  const actorIds = actors.map((actor) => actor.id);
  const actorUsernames = actors.flatMap((actor) =>
    actor.username ? [actor.username.toLowerCase()] : []
  );
  const npcIdentity = or(
    sql`EXISTS (SELECT 1 FROM ${usersTable}
      WHERE ${usersTable.id} = ${npcTradesTable.npcActorId}
        AND ${usersTable.isActor} = true)`,
    inArray(npcTradesTable.npcActorId, actorIds),
    inArray(sql`lower(${npcTradesTable.npcActorId})`, actorUsernames)
  );
  const balanceWhere = and(
    inArray(balanceTransactionsTable.type, [
      'pred_buy',
      'pred_sell',
      'perp_open',
      'perp_close',
      'perp_liquidation',
    ]),
    eq(usersTable.isActor, false),
    params.userId
      ? eq(balanceTransactionsTable.userId, params.userId)
      : undefined
  );
  const npcWhere = and(
    npcIdentity,
    params.userId
      ? StaticDataRegistry.getActor(params.userId)
        ? eq(npcTradesTable.npcActorId, params.userId)
        : sql`false`
      : undefined
  );
  const perpWhere = params.userId
    ? eq(perpPositionsTable.userId, params.userId)
    : sql`true`;
  const eligibleKeys = sql`
    SELECT 'balance' AS kind, ${balanceTransactionsTable.id} AS id,
      ${balanceTransactionsTable.createdAt} AS timestamp
    FROM ${balanceTransactionsTable}
    INNER JOIN ${usersTable} ON ${usersTable.id} = ${balanceTransactionsTable.userId}
    WHERE ${balanceWhere}
    UNION ALL
    SELECT 'npc' AS kind, ${npcTradesTable.id} AS id,
      ${npcTradesTable.executedAt} AS timestamp
    FROM ${npcTradesTable}
    WHERE ${npcWhere}
    UNION ALL
    SELECT 'perp' AS kind, ${perpPositionsTable.id} AS id,
      ${perpPositionsTable.openedAt} AS timestamp
    FROM ${perpPositionsTable}
    INNER JOIN ${usersTable} ON ${usersTable.id} = ${perpPositionsTable.userId}
    WHERE ${perpWhere}
  `;
  // The two reads retain the existing non-snapshot contract. Only selected
  // source rows (at most limit in total) are hydrated in the application.
  const [keys, counts] = await Promise.all([
    dbRead.execute<TradePageKey>(sql`
      SELECT kind, id FROM (${eligibleKeys}) AS eligible
      ORDER BY timestamp DESC, kind ASC, id DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `),
    dbRead.execute<{ value: string }>(sql`
      SELECT count(*)::text AS value FROM (${eligibleKeys}) AS eligible
    `),
  ]);
  const total = Number(counts[0]?.value ?? 0);
  const ids = (kind: TradePageKey['kind']) =>
    keys.filter((key) => key.kind === kind).map((key) => key.id);
  const balanceIds = ids('balance'),
    npcIds = ids('npc'),
    perpIds = ids('perp');
  const [balanceTransactions, npcTrades, perpPositions] = await Promise.all([
    balanceIds.length
      ? dbRead.balanceTransaction.findMany({
          where: { id: { in: balanceIds } },
        })
      : [],
    npcIds.length
      ? dbRead.npcTrade.findMany({ where: { id: { in: npcIds } } })
      : [],
    perpIds.length
      ? dbRead.perpPosition.findMany({ where: { id: { in: perpIds } } })
      : [],
  ]);

  // Fetch users for balance transactions
  const balanceUserIds = [
    ...new Set(balanceTransactions.map((tx) => tx.userId)),
  ];
  const balanceUsers = await dbRead.user.findMany({
    where: { id: { in: balanceUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      isActor: true,
    },
  });
  const balanceUsersMap = new Map(balanceUsers.map((u) => [u.id, u]));

  const npcActorIds = [...new Set(npcTrades.map((t) => t.npcActorId))];

  const usersData =
    npcActorIds.length > 0
      ? await dbRead.user.findMany({
          where: {
            id: { in: npcActorIds },
            isActor: true,
          },
          select: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
            isActor: true,
          },
        })
      : [];

  const usersDataMap = new Map(usersData.map((u) => [u.id, u]));

  const actorsMap = new Map<
    string,
    {
      id: string;
      username: string;
      displayName: string;
      profileImageUrl: string | null;
      isActor: boolean;
    }
  >();

  for (const actorId of npcActorIds) {
    const actor = StaticDataRegistry.getActor(actorId);
    const user = usersDataMap.get(actorId);

    if (user) {
      actorsMap.set(actorId, {
        id: user.id,
        username:
          user.username ||
          user.displayName?.toLowerCase().replace(/\s+/g, '-') ||
          actorId,
        displayName: user.displayName || actor?.name || actorId,
        profileImageUrl: user.profileImageUrl,
        isActor: true,
      });
    } else if (actor) {
      actorsMap.set(actorId, {
        id: actor.id,
        username: actor.name.toLowerCase().replace(/\s+/g, '-'),
        displayName: actor.name,
        profileImageUrl: actor.profileImageUrl ?? null,
        isActor: true,
      });
    }
  }

  const organizationIds = [
    ...new Set(perpPositions.map((p) => p.organizationId)),
  ];
  const organizationsMap = new Map(
    organizationIds
      .map((id) => StaticDataRegistry.getOrganization(id))
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => [o.id, { id: o.id, name: o.name, type: o.type }])
  );

  // Fetch users for perp positions
  const perpUserIds = [...new Set(perpPositions.map((p) => p.userId))];
  const perpUsers = await dbRead.user.findMany({
    where: { id: { in: perpUserIds } },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      isActor: true,
    },
  });
  const perpUsersMap = new Map(perpUsers.map((u) => [u.id, u]));

  // Fetch prediction markets for pred_buy/pred_sell balance transactions and NPC prediction trades
  const predictionMarketIds = [
    ...new Set([
      ...balanceTransactions
        .filter(
          (tx) =>
            (tx.type === 'pred_buy' || tx.type === 'pred_sell') && tx.relatedId
        )
        .map((tx) => tx.relatedId as string),
      ...npcTrades
        .filter((t) => t.marketType === 'prediction' && t.marketId)
        .map((t) => t.marketId as string),
    ]),
  ];
  const predictionMarkets =
    predictionMarketIds.length > 0
      ? await dbRead.market.findMany({
          where: { id: { in: predictionMarketIds } },
          select: {
            id: true,
            question: true,
            resolved: true,
            resolution: true,
          },
        })
      : [];
  const predictionMarketsMap = new Map(predictionMarkets.map((m) => [m.id, m]));

  // Merge and sort by timestamp
  // Filter out balance transactions from NPC actors - they have npcTrades entries instead
  const allTrades = [
    ...balanceTransactions
      .filter((tx) => {
        const user = balanceUsersMap.get(tx.userId);
        return !user?.isActor; // Exclude NPC actors
      })
      .map((tx) => {
        const isPrediction = tx.type === 'pred_buy' || tx.type === 'pred_sell';
        const market =
          isPrediction && tx.relatedId
            ? (predictionMarketsMap.get(tx.relatedId) ?? null)
            : null;
        return {
          type: 'balance' as const,
          id: tx.id,
          timestamp: tx.createdAt,
          user: balanceUsersMap.get(tx.userId) || null,
          amount: tx.amount.toString(),
          balanceBefore: tx.balanceBefore.toString(),
          balanceAfter: tx.balanceAfter.toString(),
          transactionType: tx.type,
          description: tx.description,
          relatedId: tx.relatedId,
          market,
        };
      }),
    ...npcTrades.map((trade) => {
      const actor = actorsMap.get(trade.npcActorId);
      const npcMarket =
        trade.marketType === 'prediction' && trade.marketId
          ? (predictionMarketsMap.get(trade.marketId) ?? null)
          : null;
      return {
        type: 'npc' as const,
        id: trade.id,
        timestamp: trade.executedAt,
        user: actor
          ? {
              id: actor.id,
              username: actor.username,
              displayName: actor.displayName,
              profileImageUrl: actor.profileImageUrl,
              isActor: true,
            }
          : null,
        marketType: trade.marketType,
        ticker: trade.ticker,
        marketId: trade.marketId,
        marketQuestion: npcMarket?.question ?? null,
        action: trade.action,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        sentiment: trade.sentiment,
        reason: trade.reason,
      };
    }),
    // NOTE: Position entries removed - see comment above about avoiding duplicates
    ...perpPositions.map((pos) => {
      const organization = organizationsMap.get(pos.organizationId);
      return {
        type: 'perp' as const,
        id: pos.id,
        timestamp: pos.openedAt,
        user: perpUsersMap.get(pos.userId) || null,
        ticker: pos.ticker,
        organization: organization
          ? {
              id: organization.id,
              name: organization.name,
              ticker: pos.ticker, // Use ticker from position since Organization doesn't have it
            }
          : null,
        side: pos.side,
        entryPrice: pos.entryPrice.toString(),
        currentPrice: pos.currentPrice.toString(),
        size: pos.size.toString(),
        leverage: pos.leverage,
        unrealizedPnL: pos.unrealizedPnL.toString(),
        liquidationPrice: pos.liquidationPrice.toString(),
        closedAt: pos.closedAt,
      };
    }),
  ].filter((trade) => trade.user !== null); // Filter out trades with missing users

  const hydrated = new Map(
    allTrades.map((trade) => [`${trade.type}:${trade.id}`, trade])
  );
  const trades = keys.flatMap((key) => {
    const trade = hydrated.get(`${key.kind}:${key.id}`);
    return trade ? [trade] : [];
  });
  return { trades, total, hasMore: params.offset + trades.length < total };
}
