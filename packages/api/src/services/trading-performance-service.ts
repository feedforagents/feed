import { buildCapitalBaseContributionSql, db, sql } from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { toISO } from '@feed/shared';

export const TRADING_RETURN_CAPITAL_FLOOR = 1000;

function buildCapitalContributionExpression(
  transactionAlias: string,
  scope: 'wallet'
): string {
  return buildCapitalBaseContributionSql(transactionAlias, scope);
}

export interface TradingReturnMetrics {
  capitalBase: number;
  effectiveCapitalBase: number;
  tradingReturn: number;
}

export interface WalletTradingPerformanceRow {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: string;
  balance: string;
  lifetimePnL: string;
  unrealizedPnL: string;
  netProfit: string;
  capitalBase: string;
  effectiveCapitalBase: string;
  tradingReturn: string;
  createdAt: Date | string;
  nftTokenId: number | null;
  isAgent: boolean;
  managedBy: string | null;
}

export class TradingPerformanceService {
  static calculateTradingReturnMetrics(
    lifetimePnL: number,
    capitalBase: number
  ): TradingReturnMetrics {
    const normalizedCapitalBase = Math.max(capitalBase, 0);
    const effectiveCapitalBase = Math.max(
      normalizedCapitalBase,
      TRADING_RETURN_CAPITAL_FLOOR
    );

    return {
      capitalBase: normalizedCapitalBase,
      effectiveCapitalBase,
      tradingReturn: lifetimePnL / effectiveCapitalBase,
    };
  }

  private static walletCapitalCte() {
    return sql.raw(`
      SELECT
        bt."userId" AS "userId",
        GREATEST(
          COALESCE(SUM(${buildCapitalContributionExpression('bt', 'wallet')}), 0),
          0
        )::numeric AS "capitalBase"
      FROM "BalanceTransaction" bt
      GROUP BY bt."userId"
    `);
  }

  /**
   * Unrealized PnL per user, mirroring the canonical totalPnL definition of
   * the engine's calculatePortfolioPnL
   * (packages/engine/src/services/portfolio-pnl.ts): the stored unrealized
   * PnL of open perp positions plus the mark-to-market unrealized PnL of
   * prediction positions in unresolved markets. That function reads
   * positions keyed by user id or privyId, so both CTEs aggregate position
   * rows onto the owning user's id.
   *
   * The prediction leg marks a position at its CPMM probability price, but
   * subtracts the remaining GROSS cash paid for it — not the net average
   * entry cost. Position.avgPrice is net of the entry fee
   * (calculateBuyWithFees strips the fee before pricing shares), while the
   * fee already left the wallet in cash and is not in lifetimePnL until the
   * position closes. Subtracting net avgPrice would therefore count the
   * already-paid entry fee as profit (SYMBaiEX on #1565: a 100-point buy reported
   * +0.978 instead of the equity-true +0.878). The gross basis is the net
   * cost grossed up by the trading fee rate, rounded to cents — the same
   * gross-up the sell path applies when realizing PnL (grossUpBuyAmount)
   * and the position snapshot uses for costBasis, so realized and
   * unrealized stay consistent across a partial exit.
   *
   * NOTE: this deliberately differs from calculatePortfolioPnL, which still
   * marks prediction positions off net avgPrice — portfolio reporting needs
   * the same reconciliation as follow-up.
   */
  private static perpUnrealizedCte() {
    return sql.raw(`
      SELECT
        usr."id" AS "userId",
        COALESCE(SUM(pp."unrealizedPnL"::numeric), 0)::numeric AS "perpUnrealizedPnL"
      FROM "PerpPosition" pp
      JOIN "User" usr ON pp."userId" = usr."id" OR pp."userId" = usr."privyId"
      WHERE pp."closedAt" IS NULL
      GROUP BY usr."id"
    `);
  }

  private static predictionUnrealizedCte() {
    return sql.raw(`
      SELECT
        usr."id" AS "userId",
        COALESCE(SUM(
          p."shares" * (
            CASE
              WHEN (m."yesShares" + m."noShares") > 0 THEN
                CASE WHEN p."side"
                  THEN m."noShares" / (m."yesShares" + m."noShares")
                  ELSE m."yesShares" / (m."yesShares" + m."noShares")
                END
              ELSE p."avgPrice"
            END
          )
          - ROUND(
            p."shares" * p."avgPrice"::numeric / (1 - ${FEE_CONFIG.TRADING_FEE_RATE}),
            2
          )
        ), 0)::numeric AS "predictionUnrealizedPnL"
      FROM "Position" p
      JOIN "Market" m ON m."id" = p."marketId"
      JOIN "User" usr ON p."userId" = usr."id" OR p."userId" = usr."privyId"
      WHERE m."resolved" = false
      GROUP BY usr."id"
    `);
  }

  /**
   * The D-15b rank key: net profit = lifetime (realized) PnL + unrealized
   * PnL — cash-and-position equity less approved contributions. Purchases
   * and the starting grant never enter this expression — they write balance
   * transactions and the cash balance, neither of which the metric reads —
   * so buying points cannot move a rank. The prediction leg subtracts the
   * remaining gross cash basis (see predictionUnrealizedCte), so the entry
   * fee already paid in cash is not counted as profit. The query aliases
   * pu/du must match the joins in each query that embeds this fragment.
   */
  private static netProfitExpression() {
    return sql.raw(`(
      u."lifetimePnL"::numeric
      + COALESCE(pu."perpUnrealizedPnL", 0)::numeric
      + COALESCE(du."predictionUnrealizedPnL", 0)::numeric
    )`);
  }

  private static unrealizedExpression() {
    return sql.raw(`(
      COALESCE(pu."perpUnrealizedPnL", 0)::numeric
      + COALESCE(du."predictionUnrealizedPnL", 0)::numeric
    )`);
  }

  static async getWalletLeaderboardRows(
    limit: number,
    offset: number
  ): Promise<WalletTradingPerformanceRow[]> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()}),
      perp_unrealized AS (${this.perpUnrealizedCte()}),
      prediction_unrealized AS (${this.predictionUnrealizedCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
        ${this.unrealizedExpression()} AS "unrealizedPnL",
        ${this.netProfitExpression()} AS "netProfit",
        COALESCE(wc."capitalBase", 0)::numeric AS "capitalBase",
        GREATEST(
          COALESCE(wc."capitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "effectiveCapitalBase",
        (
          u."lifetimePnL"::numeric /
          GREATEST(
            COALESCE(wc."capitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "tradingReturn",
        u."createdAt",
        u."nftTokenId",
        u."isAgent",
        u."managedBy"
      FROM "User" u
      LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
      LEFT JOIN perp_unrealized pu ON pu."userId" = u."id"
      LEFT JOIN prediction_unrealized du ON du."userId" = u."id"
      WHERE u."isActor" = false AND u."isAgent" = false
      ORDER BY "netProfit" DESC, u."createdAt" ASC, u."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return result as unknown as WalletTradingPerformanceRow[];
  }

  static async getWalletEntry(
    userId: string
  ): Promise<WalletTradingPerformanceRow | null> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()}),
      perp_unrealized AS (${this.perpUnrealizedCte()}),
      prediction_unrealized AS (${this.predictionUnrealizedCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
        ${this.unrealizedExpression()} AS "unrealizedPnL",
        ${this.netProfitExpression()} AS "netProfit",
        COALESCE(wc."capitalBase", 0)::numeric AS "capitalBase",
        GREATEST(
          COALESCE(wc."capitalBase", 0)::numeric,
          ${TRADING_RETURN_CAPITAL_FLOOR}
        )::numeric AS "effectiveCapitalBase",
        (
          u."lifetimePnL"::numeric /
          GREATEST(
            COALESCE(wc."capitalBase", 0)::numeric,
            ${TRADING_RETURN_CAPITAL_FLOOR}
          )
        )::numeric AS "tradingReturn",
        u."createdAt",
        u."nftTokenId",
        u."isAgent",
        u."managedBy"
      FROM "User" u
      LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
      LEFT JOIN perp_unrealized pu ON pu."userId" = u."id"
      LEFT JOIN prediction_unrealized du ON du."userId" = u."id"
      WHERE u."isActor" = false AND u."isAgent" = false AND u."id" = ${userId}
      LIMIT 1
    `);

    const rows = result as unknown as WalletTradingPerformanceRow[];
    return rows[0] ?? null;
  }

  static async countWalletsAbove(entry: {
    id: string;
    createdAt: Date | string;
    netProfit: string;
  }): Promise<number> {
    const createdAtISO = toISO(entry.createdAt);
    const result = await db.execute(sql`
      WITH perp_unrealized AS (${this.perpUnrealizedCte()}),
      prediction_unrealized AS (${this.predictionUnrealizedCte()}),
      wallet_rows AS (
        SELECT
          u."id",
          u."createdAt",
          ${this.netProfitExpression()} AS "netProfit"
        FROM "User" u
        LEFT JOIN perp_unrealized pu ON pu."userId" = u."id"
        LEFT JOIN prediction_unrealized du ON du."userId" = u."id"
        WHERE u."isActor" = false AND u."isAgent" = false
      )
      SELECT COUNT(*)::int AS "count"
      FROM wallet_rows wr
      WHERE
        wr."netProfit" > ${entry.netProfit}
        OR (
          wr."netProfit" = ${entry.netProfit}
          AND (
            wr."createdAt" < ${createdAtISO}
            OR (
              wr."createdAt" = ${createdAtISO}
              AND wr."id" < ${entry.id}
            )
          )
        )
    `);

    const rows = result as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }
}
