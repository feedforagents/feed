import { afterAll, describe, expect, it } from 'bun:test';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  tradingFees,
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { MCPRequestHandler } from '../../mcp/src/handlers/mcp-request-handler';
import { MCPMethod, type ToolCallResult } from '../../mcp/src/types/mcp';

const owners: string[] = [];
const tickers: string[] = [];

async function fixture() {
  const userId = await generateSnowflakeId();
  owners.push(userId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `mcp-lev-${userId}`,
    virtualBalance: '10000',
    totalDeposited: '10000',
    profileComplete: true,
    updatedAt: new Date(),
  });
  const apiKey = generateApiKey();
  await dbWrite.insert(userApiKeys).values({
    id: await generateSnowflakeId(),
    userId,
    keyHash: hashApiKey(apiKey),
  });
  const ticker = `ML${userId}`;
  tickers.push(ticker);
  await dbWrite.insert(organizationState).values({
    id: ticker,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: new Date(),
  });
  await dbWrite.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: ticker,
    currentPrice: 100,
    markPrice: 100,
    indexPrice: 100,
    high24h: 100,
    low24h: 100,
    openInterest: 1000000,
    bidDepth: 1000000,
    askDepth: 1000000,
    maxLeverage: 20,
    minOrderSize: 10,
    fundingRate: {
      ticker,
      rate: 0,
      predictedRate: 0,
      nextFundingTime: new Date().toISOString(),
    },
  });
  return { userId, apiKey, ticker };
}

// The same JSON-RPC call an MCP client sends to /api/mcp.
async function openPosition(
  f: { apiKey: string; ticker: string },
  leverage: number
) {
  const response = await new MCPRequestHandler().handle(
    {
      jsonrpc: '2.0',
      id: 1,
      method: MCPMethod.TOOLS_CALL,
      params: {
        name: 'open_position',
        arguments: { ticker: f.ticker, side: 'LONG', amount: 100, leverage },
      },
    },
    { apiKey: f.apiKey }
  );
  const result = response.result as unknown as ToolCallResult;
  const [content] = result.content;
  return {
    isError: result.isError,
    text: content?.type === 'text' ? content.text : '',
  };
}

async function state(userId: string) {
  const positions = await dbWrite
    .select()
    .from(perpPositions)
    .where(eq(perpPositions.userId, userId));
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  return {
    positions: positions.map((position) => ({
      size: position.size,
      leverage: position.leverage,
    })),
    ledgerRows: ledger.length,
    balance: Number(user?.virtualBalance),
  };
}

afterAll(async () => {
  if (owners.length) {
    await dbWrite
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, owners));
    await dbWrite
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, owners));
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, owners));
    await dbWrite
      .delete(userApiKeys)
      .where(inArray(userApiKeys.userId, owners));
    await dbWrite.delete(users).where(inArray(users.id, owners));
  }
  if (tickers.length) {
    await dbWrite
      .delete(perpMarketSnapshots)
      .where(inArray(perpMarketSnapshots.ticker, tickers));
    await dbWrite
      .delete(organizationState)
      .where(inArray(organizationState.id, tickers));
  }
});

describe('MCP open_position leverage with real Postgres', () => {
  for (const leverage of [2.5, 1.4]) {
    it(`rejects ${leverage}x as invalid input before the order reaches the database`, async () => {
      const f = await fixture();
      const before = await state(f.userId);

      const reply = await openPosition(f, leverage);

      // PerpPosition.leverage is an integer column. Without input validation
      // the insert fails and the tool error carries the SQL text and row
      // parameters back to the agent.
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('leverage');
      expect(reply.text).not.toContain('Failed query');
      expect(reply.text).not.toContain('PerpPosition');
      expect(await state(f.userId)).toEqual(before);
    });
  }

  it('still opens a whole-number leverage position', async () => {
    const f = await fixture();

    const reply = await openPosition(f, 2);

    expect(reply.isError).toBe(false);
    expect(JSON.parse(reply.text)).toMatchObject({
      position: { ticker: f.ticker, side: 'LONG', size: 100, leverage: 2 },
      marginPaid: 50,
    });
    const after = await state(f.userId);
    expect(after.positions).toEqual([{ size: 100, leverage: 2 }]);
    // Margin of 50 leaves the balance; the trading fee comes on top.
    expect(after.balance).toBeLessThanOrEqual(9950);
  });
});
