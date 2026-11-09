/**
 * Integration test: NPC de-risking must close open leveraged positions even
 * when closed positions hold the highest leverage values.
 *
 * `generateDeRiskingActions` orders poolPositions by leverage DESC and takes
 * LIMIT positionsToClose, but the closed/open and leverage>1 filters ran in
 * memory after the limit. Closed rows keep their leverage, so they occupy
 * the top-N slots and the de-risk silently closes fewer live positions than
 * intended — in the worst case none at all — even while riskScore is above
 * the de-risk threshold. Runs against a real Postgres database (DATABASE_URL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, eq, poolPositions } from '@feed/db';
import {
  NPCInvestmentManager,
  type PortfolioMetrics,
  type RebalanceAction,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

// generateDeRiskingActions is private; reach it through a typed cast so the
// test pins the de-risk selection behaviour without running a full tick.
const generateDeRiskingActions = (
  NPCInvestmentManager as unknown as {
    generateDeRiskingActions: (
      poolId: string,
      metrics: PortfolioMetrics
    ) => Promise<RebalanceAction[]>;
  }
).generateDeRiskingActions;

const suffix = Date.now().toString(36);
const POOL_ID = `test-npc-derisk-${suffix}`;
const OPEN_IDS: string[] = [];
const CLOSED_IDS: string[] = [];

const HIGH_RISK_METRICS: PortfolioMetrics = {
  totalValue: 100_000,
  availableBalance: 10_000,
  unrealizedPnL: 0,
  realizedPnL: 0,
  positionCount: 6,
  utilization: 90,
  riskScore: 0.8,
};

async function insertPosition(options: {
  id: string;
  leverage: number;
  closedAt: Date | null;
}): Promise<void> {
  const now = new Date();
  await db.insert(poolPositions).values({
    id: options.id,
    poolId: POOL_ID,
    marketType: 'prediction',
    marketId: `test-market-${suffix}`,
    side: 'YES',
    entryPrice: 100,
    currentPrice: 100,
    size: 100,
    leverage: options.leverage,
    unrealizedPnL: 0,
    openedAt: now,
    closedAt: options.closedAt,
    updatedAt: now,
  });
}

describe('NPCInvestmentManager.generateDeRiskingActions', () => {
  beforeAll(async () => {
    // Three CLOSED rows hold the highest leverage (10x). Three OPEN rows
    // sit below them (5x). positionsToClose is 3 at riskScore 0.8 with no
    // losses, so a limit-before-filter query returns only closed rows.
    for (let index = 0; index < 3; index++) {
      const closedId = await generateSnowflakeId();
      CLOSED_IDS.push(closedId);
      await insertPosition({
        id: closedId,
        leverage: 10,
        closedAt: new Date(),
      });
    }
    for (let index = 0; index < 3; index++) {
      const openId = await generateSnowflakeId();
      OPEN_IDS.push(openId);
      await insertPosition({ id: openId, leverage: 5, closedAt: null });
    }
  });

  afterAll(async () => {
    await db.delete(poolPositions).where(eq(poolPositions.poolId, POOL_ID));
  });

  it('closes the open leveraged positions instead of the closed high-leverage rows', async () => {
    const actions = await generateDeRiskingActions(POOL_ID, HIGH_RISK_METRICS);

    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.positionId).sort()).toEqual(
      [...OPEN_IDS].sort()
    );
    for (const action of actions) {
      expect(action.type).toBe('close');
    }
  });
});
