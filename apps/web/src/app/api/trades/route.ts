/**
 * Trading Activity Feed API
 *
 * @route GET /api/trades
 * @access Public
 *
 * @description
 * Public trading feed showing recent trading activity across all market types:
 * - Prediction market positions (YES/NO binary predictions)
 * - Perpetual futures positions (long/short leveraged trades)
 * - NPC/agent trades with sentiment and reasoning
 * - Balance transactions (buys, sells, deposits, withdrawals)
 *
 * @openapi
 * /api/trades:
 *   get:
 *     tags:
 *       - Trading
 *     summary: Get trading feed
 *     description: Public trading feed showing recent activity across all market types with user/agent profiles.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Trades per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by specific user/agent
 *     responses:
 *       200:
 *         description: Trading feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *
 * **Trade Types:**
 * - **balance:** User balance transactions (pred_buy, pred_sell, perp operations)
 * - **npc:** Agent/NPC trades with AI reasoning and sentiment
 * - **position:** Prediction market positions with shares and pricing
 * - **perp:** Perpetual futures positions with leverage and PnL
 *
 * **Features:**
 * - Combined feed across all market types
 * - User-specific filtering
 * - Pagination support
 * - Rich trader profiles (users, agents, actors)
 * - Market metadata (questions, tickers, organizations)
 * - Real-time pricing and PnL calculations
 *
 * **Query Parameters:**
 * @query {number} limit - Trades per page (1-100, default: 50)
 * @query {number} offset - Pagination offset (default: 0)
 * @query {string} userId - Filter by specific user/agent/actor
 *
 * **Trade Object Types:**
 *
 * **Balance Transaction:**
 * @property {string} type - 'balance'
 * @property {object} user - Trader profile
 * @property {string} transactionType - Transaction type (pred_buy, pred_sell, etc.)
 * @property {string} amount - Transaction amount
 * @property {string} balanceBefore - Balance before transaction
 * @property {string} balanceAfter - Balance after transaction
 *
 * **NPC/Agent Trade:**
 * @property {string} type - 'npc'
 * @property {object} user - Agent profile
 * @property {string} marketType - Market type
 * @property {string} ticker - Trading symbol
 * @property {string} action - Trade action
 * @property {string} side - Trade side (long/short, YES/NO)
 * @property {string} sentiment - AI sentiment analysis
 * @property {string} reason - AI reasoning for trade
 *
 * **Position:**
 * @property {string} type - 'position'
 * @property {object} market - Market details
 * @property {string} side - Position side (YES/NO)
 * @property {string} shares - Number of shares
 * @property {string} avgPrice - Average entry price
 *
 * **Perpetual Position:**
 * @property {string} type - 'perp'
 * @property {object} organization - Company being traded
 * @property {string} side - Position side (long/short)
 * @property {number} leverage - Leverage multiplier
 * @property {string} entryPrice - Entry price
 * @property {string} currentPrice - Current price
 * @property {string} unrealizedPnL - Unrealized profit/loss
 * @property {string} liquidationPrice - Liquidation price
 *
 * @returns {object} Trading feed response
 * @property {array} trades - Array of trade objects (mixed types)
 * @property {number} total - Total trades before limit
 * @property {boolean} hasMore - Whether more trades available
 *
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get recent trades
 * const feed = await fetch('/api/trades?limit=20');
 * const { trades } = await feed.json();
 *
 * // Get user's trades
 * const userTrades = await fetch(`/api/trades?userId=${userId}&limit=50`);
 *
 * // Process different trade types
 * trades.forEach(trade => {
 *   switch(trade.type) {
 *     case 'npc':
 *       console.log(`${trade.user.displayName}: ${trade.reason}`);
 *       break;
 *     case 'perp':
 *       console.log(`Perp ${trade.side} ${trade.ticker} @${trade.entryPrice}`);
 *       break;
 *     // ... handle other types
 *   }
 * });
 * ```
 *
 * @see {@link /lib/database-service} Database queries
 * @see {@link /src/app/trades/page.tsx} Trading feed UI
 * @see {@link /src/components/trading} Trading components
 */

import {
  addPublicReadHeaders,
  getTradesFeed,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  userId: z.string().optional(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const params = QuerySchema.parse({
    limit: searchParams.get('limit') || '50',
    offset: searchParams.get('offset') || '0',
    userId: searchParams.get('userId') || undefined,
  });

  logger.info('Public trading feed requested', { params }, 'GET /api/trades');

  const res = successResponse(await getTradesFeed(params));
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
