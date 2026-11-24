/**
 * PRD §8.1: per-account rate limits (trades per hour, etc.) apply across all
 * clients and the web. MCP and A2A already cap prediction buys and sells with
 * RATE_LIMIT_CONFIGS.BUY_PREDICTION / SELL_PREDICTION (10 per minute); the
 * website routes must apply the same per-account limit.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  notifications,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  tradingFees,
  userAchievements,
  userChallengeProgress,
  users,
} from '@feed/db';
import { RATE_LIMIT_CONFIGS } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { executeTool } from '../../mcp/src/handlers/tool-handlers';

// Only the server-only environment marker is stubbed; the routes run as is.
mock.module('server-only', () => ({}));

type Route = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let buyRoute: Route;
let sellRoute: Route;

const ip = crypto.getRandomValues(new Uint8Array(2));
const clientIp = `198.19.${ip[0]}.${ip[1]}`;
let userId: string;
let mixedUserId: string;
let marketId: string;

async function createUser(prefix: string) {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `${prefix}-${id}`,
    virtualBalance: '1000',
    totalDeposited: '1000',
    updatedAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  ({ POST: buyRoute } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/buy/route'
  ));
  ({ POST: sellRoute } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/sell/route'
  ));
  userId = await createUser('trade-rl');
  mixedUserId = await createUser('trade-rl-mixed');
  marketId = await generateSnowflakeId();
  await db.insert(markets).values({
    id: marketId,
    question: `prediction-trade-rate-limit-${marketId}`,
    liquidity: '1000',
    yesShares: '500',
    noShares: '500',
    resolved: false,
    endDate: new Date('2027-06-01T00:00:00.000Z'),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  const ids = [userId, mixedUserId];
  // Every trade records a fee, and the first trades can award an achievement,
  // challenge progress and their notifications; leave none of them behind.
  await db.delete(tradingFees).where(inArray(tradingFees.userId, ids));
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  await db
    .delete(userChallengeProgress)
    .where(inArray(userChallengeProgress.userId, ids));
  await db
    .delete(userAchievements)
    .where(inArray(userAchievements.userId, ids));
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, ids));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, ids));
  await db.delete(positions).where(inArray(positions.userId, ids));
  await db
    .delete(predictionPriceHistories)
    .where(eq(predictionPriceHistories.marketId, marketId));
  await db.delete(markets).where(eq(markets.id, marketId));
  await db.delete(users).where(inArray(users.id, ids));
});

async function trade(
  route: Route,
  action: string,
  body: object,
  asUser = userId
) {
  const previous = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
  try {
    return await route(
      new NextRequest(
        `http://localhost/api/markets/predictions/${marketId}/${action}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': clientIp,
            authorization: `Bearer steward:test:${asUser}`,
          },
          body: JSON.stringify(body),
        }
      ),
      { params: Promise.resolve({ id: marketId }) }
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previous;
  }
}

async function snapshot() {
  const [user] = await db
    .select({ balance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId));
  const [position] = await db
    .select({ shares: positions.shares })
    .from(positions)
    .where(eq(positions.userId, userId));
  return { balance: user?.balance, shares: position?.shares };
}

test('the website refuses a prediction buy over the per-account limit', async () => {
  const limit = RATE_LIMIT_CONFIGS.BUY_PREDICTION.maxRequests;
  for (let i = 0; i < limit; i++) {
    const response = await trade(buyRoute, 'buy', { side: 'yes', amount: 5 });
    expect(response.status).toBe(201);
  }
  const before = await snapshot();
  const response = await trade(buyRoute, 'buy', { side: 'yes', amount: 5 });
  expect(response.status).toBe(429);
  expect(await snapshot()).toEqual(before);
});

test('the website refuses a prediction sell over the per-account limit', async () => {
  const limit = RATE_LIMIT_CONFIGS.SELL_PREDICTION.maxRequests;
  for (let i = 0; i < limit; i++) {
    const response = await trade(sellRoute, 'sell', { shares: 1 });
    expect(response.status).toBe(200);
  }
  const before = await snapshot();
  const response = await trade(sellRoute, 'sell', { shares: 1 });
  expect(response.status).toBe(429);
  expect(await snapshot()).toEqual(before);
});

test('website and MCP prediction buys share one per-account limit', async () => {
  const limit = RATE_LIMIT_CONFIGS.BUY_PREDICTION.maxRequests;
  const agent = { agentId: 'rate-limit-agent', userId: mixedUserId };
  for (let i = 0; i < limit / 2; i++) {
    await executeTool(
      'buy_shares',
      { marketId, outcome: 'YES', amount: 5 },
      agent
    );
  }
  for (let i = 0; i < limit / 2; i++) {
    const response = await trade(
      buyRoute,
      'buy',
      { side: 'yes', amount: 5 },
      mixedUserId
    );
    expect(response.status).toBe(201);
  }
  const response = await trade(
    buyRoute,
    'buy',
    { side: 'yes', amount: 5 },
    mixedUserId
  );
  expect(response.status).toBe(429);
});
