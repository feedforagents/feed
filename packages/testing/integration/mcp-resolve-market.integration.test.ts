/**
 * MCP resolve_market must leave every market list in the same state.
 *
 * The market lists do not all read the same table: the trading list
 * (GET /api/markets/predictions) filters on markets.resolved, while the
 * sidebar trending widget and the new-markets feed include a market when
 * its question row is still status='active'. The admin web route keeps
 * the two in sync by updating questions (and timeframedMarkets) in the
 * same transaction as the settlement; this test pins the MCP admin path
 * to the same outcome so a market resolved by an agent admin cannot keep
 * appearing as live in the question-driven lists.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, eq, markets, questions, timeframedMarkets, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeResolveMarket } from '../../mcp/src/handlers/tool-handlers';

let adminUserId: string;
let marketId: string;
let timeframedId: string;

describe('MCP resolve_market list consistency', () => {
  beforeAll(async () => {
    adminUserId = await generateSnowflakeId();
    await db.insert(users).values({
      id: adminUserId,
      username: `mcp_admin_${adminUserId.slice(-10)}`,
      isActor: false,
      isAdmin: true,
      updatedAt: new Date(),
    });

    marketId = await generateSnowflakeId();
    const endDate = new Date(Date.now() + 86_400_000);
    await db.insert(markets).values({
      id: marketId,
      question: 'Will the MCP-resolved market leave every list?',
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      endDate,
      updatedAt: new Date(),
    });
    await db.insert(questions).values({
      id: marketId,
      questionNumber: 1_900_000_000 + (Date.now() % 100_000_000),
      marketId,
      text: 'Will the MCP-resolved market leave every list?',
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: endDate,
      status: 'active',
      updatedAt: new Date(),
    });
    timeframedId = await generateSnowflakeId();
    await db.insert(timeframedMarkets).values({
      id: timeframedId,
      questionId: marketId,
      timeframe: '24h',
      startTime: new Date(),
      endTime: endDate,
      arcStateEnteredAt: new Date(),
      isActive: true,
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db
      .delete(timeframedMarkets)
      .where(eq(timeframedMarkets.id, timeframedId));
    await db.delete(questions).where(eq(questions.id, marketId));
    await db.delete(markets).where(eq(markets.id, marketId));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it('removes the market from question-driven lists after an MCP resolve', async () => {
    const result = await executeResolveMarket(
      { agentId: 'agent', userId: adminUserId },
      { marketId, resolution: true }
    );
    expect(result.success).toBe(true);

    // Trading-list predicate (markets.resolved = false): excluded.
    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId));
    expect(market?.resolved).toBe(true);

    // Question-driven lists (widget, new-markets) include a market only
    // while its question is 'active': the question must leave that state.
    const [question] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, marketId));
    expect(question?.status).toBe('resolved');
    expect(question?.resolvedOutcome).toBe(true);

    const stillListedAsActive = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.status, 'active'));
    expect(stillListedAsActive.map((q) => q.id)).not.toContain(marketId);

    // The tick's source of truth for sub-markets must agree.
    const [timeframed] = await db
      .select()
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.id, timeframedId));
    expect(timeframed?.isActive).toBe(false);
    expect(timeframed?.isResolved).toBe(true);
  });
});
