/**
 * MCP get_positions must list the agent's open perpetual positions too.
 *
 * The tool is advertised as "Get all open positions" (docs/skills.md MCP
 * table and the tool registration in mcp-server.ts), and the same server
 * opens perpetual positions (open_position) and closes them
 * (close_position). The A2A counterpart, portfolio.get_positions, returns
 * both marketPositions and perpPositions. On base the MCP handler only
 * queries the prediction Position table, so an open perp is invisible.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  eq,
  inArray,
  markets,
  perpPositions,
  positions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetPositions } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
let agentUserId: string;
let otherUserId: string;
let marketId: string;
let activePredictionId: string;
let openPerpId: string;
let closedPerpId: string;
let otherPerpId: string;

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `mcppos_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

describe('MCP get_positions perpetual coverage', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    otherUserId = await createUser();

    marketId = await generateSnowflakeId();
    await db.insert(markets).values({
      id: marketId,
      question: 'Will the MCP list every open position?',
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });

    activePredictionId = await generateSnowflakeId();
    await db.insert(positions).values({
      id: activePredictionId,
      userId: agentUserId,
      marketId,
      side: true,
      shares: '10',
      avgPrice: '0.5',
      status: 'active',
      updatedAt: new Date(),
    });

    const perpRow = (
      id: string,
      userId: string,
      closedAt: Date | null
    ): typeof perpPositions.$inferInsert => ({
      id,
      userId,
      ticker: 'ACME',
      organizationId: `org-${id}`,
      side: 'long',
      entryPrice: 100,
      currentPrice: 110,
      size: 25,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 250,
      unrealizedPnLPercent: 10,
      fundingPaid: 0,
      lastUpdated: new Date(),
      closedAt,
    });

    openPerpId = await generateSnowflakeId();
    closedPerpId = await generateSnowflakeId();
    otherPerpId = await generateSnowflakeId();
    await db
      .insert(perpPositions)
      .values([
        perpRow(openPerpId, agentUserId, null),
        perpRow(closedPerpId, agentUserId, new Date()),
        perpRow(otherPerpId, otherUserId, null),
      ]);
  });

  afterAll(async () => {
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, userIds));
    await db.delete(positions).where(inArray(positions.userId, userIds));
    await db.delete(markets).where(eq(markets.id, marketId));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('still lists the open prediction position (guard)', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(result.positions.map((p) => p.id)).toEqual([activePredictionId]);
  });

  it('lists the agent open perp position alongside prediction positions', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(result.perpPositions).toBeDefined();
    expect(result.perpPositions!.map((p) => p.id)).toEqual([openPerpId]);
    expect(result.perpPositions![0]).toMatchObject({
      id: openPerpId,
      ticker: 'ACME',
      side: 'LONG',
      size: '25',
      entryPrice: '100',
      currentPrice: '110',
      leverage: 2,
      unrealizedPnL: '250',
    });
  });

  it('excludes closed perps and other users perps', async () => {
    const result = await executeGetPositions(agent(), {});
    const ids = (result.perpPositions ?? []).map((p) => p.id);
    expect(ids).not.toContain(closedPerpId);
    expect(ids).not.toContain(otherPerpId);
  });

  it('returns no perp positions when a marketId filter is given', async () => {
    const result = await executeGetPositions(agent(), { marketId });
    expect(result.positions.map((p) => p.id)).toEqual([activePredictionId]);
    expect(result.perpPositions ?? []).toEqual([]);
  });
});
