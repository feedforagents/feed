/**
 * New Markets Feed API
 *
 * @route GET /api/feed/new-markets — recently opened prediction market questions
 *
 * Returns active questions opened in the last 24 h whose closing time
 * is still ahead.
 * Joins the markets table to include the market UUID (for deep-linking to
 * /markets/predictions/[id]) and live yes/no shares (for real probability bars).
 */
import {
  getCacheOrFetch,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  arcStates,
  db,
  desc,
  eq,
  gt,
  gte,
  lt,
  markets,
  questions,
} from '@feed/db';
import type { ArcStateType } from '@feed/shared';
import { toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { dedupeQuestionMarketRows } from '../questionMarketRows';

const NEW_MARKET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NewMarketEntry {
  questionNumber: number;
  text: string;
  resolutionDate: string;
  createdAt: string;
  arcState: ArcStateType | null;
  /** Market UUID for deep-linking to /markets/predictions/[marketId] */
  marketId: string | null;
  /** Live YES share count — new markets always open at 0 (displayed as 50%) */
  yesShares: number;
  /** Live NO share count — new markets always open at 0 (displayed as 50%) */
  noShares: number;
}

export interface NewMarketsResponse {
  success: true;
  markets: NewMarketEntry[];
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error: rateLimitErr, rateLimitInfo } = await publicRateLimit(
    request,
    'read'
  );
  if (rateLimitErr) return rateLimitErr;

  const cacheKey = 'feed:new-markets:v3';

  const result = await getCacheOrFetch<NewMarketEntry[]>(
    cacheKey,
    async () => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - NEW_MARKET_WINDOW_MS);

      // Join questions → arcStates → markets by stable foreign keys.
      // LEFT JOIN so questions without a market
      // are still returned (isNewMarket card falls back to the predictions list).
      const rows = await db
        .select({
          questionNumber: questions.questionNumber,
          text: questions.text,
          resolutionDate: questions.resolutionDate,
          createdAt: questions.createdAt,
          arcState: arcStates.currentState,
          marketId: markets.id,
          yesShares: markets.yesShares,
          noShares: markets.noShares,
        })
        .from(questions)
        .leftJoin(arcStates, eq(arcStates.questionId, questions.id))
        .leftJoin(markets, eq(markets.id, questions.marketId))
        .where(
          and(
            eq(questions.status, 'active'),
            gte(questions.createdAt, cutoff),
            // Trading closes at the deadline, even while resolution is pending.
            gt(questions.resolutionDate, now),
            // Only markets resolving within 30 days
            lt(
              questions.resolutionDate,
              new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
            )
          )
        )
        .orderBy(desc(questions.createdAt), desc(markets.createdAt));

      // Dedupe before slicing so duplicate join rows cannot crowd out
      // later unique questions from the final feed payload.
      return dedupeQuestionMarketRows(rows)
        .slice(0, 5)
        .map((r) => ({
          questionNumber: r.questionNumber,
          text: r.text,
          resolutionDate: toISO(r.resolutionDate),
          createdAt: toISO(r.createdAt),
          arcState: (r.arcState as ArcStateType | null) ?? null,
          marketId: r.marketId ?? null,
          yesShares: Number(r.yesShares ?? 0),
          noShares: Number(r.noShares ?? 0),
        }));
    },
    { namespace: 'feed', ttl: 60 } // shorter TTL since odds can change
  );

  const response = successResponse({
    success: true,
    markets: result,
  } satisfies NewMarketsResponse);

  if (rateLimitInfo) {
    response.headers.set(
      'Cache-Control',
      'public, s-maxage=30, stale-while-revalidate=60'
    );
  }
  return response;
});
