import { buildCapitalBaseContributionSql, db, sql } from '@feed/db';
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

  static async getWalletLeaderboardRows(
    limit: number,
    offset: number
  ): Promise<WalletTradingPerformanceRow[]> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
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
      WHERE u."isActor" = false AND u."isAgent" = false
      ORDER BY "tradingReturn" DESC, u."createdAt" ASC, u."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return result as unknown as WalletTradingPerformanceRow[];
  }

  static async getWalletEntry(
    userId: string
  ): Promise<WalletTradingPerformanceRow | null> {
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()})
      SELECT
        u."id",
        u."username",
        u."displayName",
        u."profileImageUrl",
        u."reputationPoints"::numeric AS "reputationPoints",
        u."virtualBalance"::numeric AS "balance",
        u."lifetimePnL"::numeric AS "lifetimePnL",
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
      WHERE u."isActor" = false AND u."isAgent" = false AND u."id" = ${userId}
      LIMIT 1
    `);

    const rows = result as unknown as WalletTradingPerformanceRow[];
    return rows[0] ?? null;
  }

  static async countWalletsAbove(entry: {
    id: string;
    createdAt: Date | string;
    tradingReturn: string;
  }): Promise<number> {
    const createdAtISO = toISO(entry.createdAt);
    const result = await db.execute(sql`
      WITH wallet_capital AS (${this.walletCapitalCte()}),
      wallet_rows AS (
        SELECT
          u."id",
          u."createdAt",
          (
            u."lifetimePnL"::numeric /
            GREATEST(
              COALESCE(wc."capitalBase", 0)::numeric,
              ${TRADING_RETURN_CAPITAL_FLOOR}
            )
          )::numeric AS "tradingReturn"
        FROM "User" u
        LEFT JOIN wallet_capital wc ON wc."userId" = u."id"
        WHERE u."isActor" = false AND u."isAgent" = false
      )
      SELECT COUNT(*)::int AS "count"
      FROM wallet_rows wr
      WHERE
        wr."tradingReturn" > ${entry.tradingReturn}
        OR (
          wr."tradingReturn" = ${entry.tradingReturn}
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
