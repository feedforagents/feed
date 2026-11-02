/**
 * Integration test: autonomous perp opens record the executed entry price
 *
 * executeDirectTrade is the execution path of the autonomous trading loop.
 * The AgentTrade row it writes is the agent's trade history, so its price
 * must be the price the position actually opened at, not the static seed
 * price of the organization.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { executeDirectTrade } from '@feed/agents';
import {
  agentLogs,
  agentTrades,
  and,
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  tradingFees,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const TICKER = 'TSLAI';
const org = StaticDataRegistry.getAllOrganizations().find(
  (o) => o.ticker === TICKER
);
if (!org) throw new Error(`Static organization ${TICKER} is missing`);
const seedPrice = org.initialPrice ?? 100;
// A live price far from the static seed price, as after any market tick.
const livePrice = Math.round(seedPrice * 1.5 * 100) / 100;

let agentUserId = '';
let originalSnapshot: typeof perpMarketSnapshots.$inferSelect | undefined;
let originalOrgState: typeof organizationState.$inferSelect | undefined;

describe('autonomous perp trade record', () => {
  beforeAll(async () => {
    agentUserId = await generateSnowflakeId();
    const username = `test-perp-rec-${agentUserId.slice(-8)}`;
    await db.insert(users).values({
      id: agentUserId,
      privyId: `did:privy:test-${agentUserId}`,
      username,
      displayName: username,
      profileComplete: true,
      isAgent: true,
      virtualBalance: '1000',
      updatedAt: new Date(),
    });

    [originalSnapshot] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, TICKER));
    const now = new Date();
    const fixture = {
      currentPrice: livePrice,
      markPrice: livePrice,
      indexPrice: livePrice,
      high24h: livePrice,
      low24h: livePrice,
      metrics24hResetAt: now,
      price24hAgoUpdatedAt: now,
    };
    await db
      .insert(perpMarketSnapshots)
      .values({
        ticker: TICKER,
        organizationId: org.id,
        fundingRate: {
          ticker: TICKER,
          rate: 0,
          nextFundingTime: now.toISOString(),
          predictedRate: 0,
        },
        ...fixture,
      })
      .onConflictDoUpdate({ target: perpMarketSnapshots.ticker, set: fixture });

    [originalOrgState] = await db
      .select()
      .from(organizationState)
      .where(eq(organizationState.id, org.id));
    const orgFixture = {
      currentPrice: livePrice,
      basePrice: livePrice,
      updatedAt: now,
    };
    await db
      .insert(organizationState)
      .values({ id: org.id, ...orgFixture })
      .onConflictDoUpdate({ target: organizationState.id, set: orgFixture });
  });

  afterAll(async () => {
    await db
      .delete(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId));
    await db.delete(agentLogs).where(eq(agentLogs.agentUserId, agentUserId));
    await db.delete(tradingFees).where(eq(tradingFees.userId, agentUserId));
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, agentUserId));
    await db.delete(perpPositions).where(eq(perpPositions.userId, agentUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
    if (originalSnapshot) {
      await db
        .update(perpMarketSnapshots)
        .set(originalSnapshot)
        .where(eq(perpMarketSnapshots.ticker, TICKER));
    } else {
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, TICKER));
    }
    if (originalOrgState) {
      await db
        .update(organizationState)
        .set(originalOrgState)
        .where(eq(organizationState.id, org.id));
    } else {
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, org.id));
    }
  });

  it('records the position entry price, not the static seed price', async () => {
    const result = await executeDirectTrade({
      agentUserId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'open_long',
      amount: 100,
      reasoning: 'integration test',
      skipPerpResolution: true,
    });
    expect(result.success).toBe(true);

    const [position] = await db
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, agentUserId),
          eq(perpPositions.ticker, TICKER)
        )
      );
    expect(position).toBeDefined();

    const [trade] = await db
      .select()
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId));
    expect(trade?.action).toBe('open');
    expect(trade?.price).toBeCloseTo(position?.entryPrice ?? Number.NaN, 8);
    expect(trade?.price).not.toBeCloseTo(seedPrice, 2);
  });
});
