import { describe, expect, mock, test } from 'bun:test';

// A2A `portfolio.get_positions` marks open prediction positions at
// `shares * (currentPrice - avgPrice)`. Position.avgPrice is net of the
// entry fee, while the fee already left the wallet in cash and is not in
// lifetimePnL until the position closes — so the fee is counted as profit,
// and the agent-facing total disagrees with the engine portfolio path
// (calculatePortfolioPnL), which marks against the persisted gross
// cashCostBasis. Same defect class as the perp-funding netting in
// a2a-get-positions-funding.test.ts, on the prediction side.
const actualDbModule = await import('@feed/db');

const userId = 'a2a-prediction-basis-audit-user';
const marketId = 'a2a-prediction-basis-market';

type PositionRow = Record<string, unknown>;
type MarketRow = Record<string, unknown>;

let currentPositionRows: PositionRow[] = [];
let currentMarketRows: MarketRow[] = [];

const mockDb = {
  user: {
    findUnique: mock(() => Promise.resolve({ id: userId })),
  },
  position: {
    findMany: mock(() => Promise.resolve(currentPositionRows)),
  },
  market: {
    findMany: mock(() => Promise.resolve(currentMarketRows)),
  },
  perpPosition: {
    findMany: mock(() => Promise.resolve([])),
  },
  organizationState: {
    findMany: mock(() => Promise.resolve([])),
  },
};

mock.module('@feed/db', () => ({
  ...actualDbModule,
  db: mockDb,
}));

const { FeedAgentExecutor } = await import(
  '../../a2a/src/executors/feed-executor'
);

function marketRow(overrides: MarketRow = {}): MarketRow {
  return {
    id: marketId,
    question: `a2a-prediction-basis-${marketId}`,
    resolved: false,
    yesShares: 5000,
    noShares: 5000,
    ...overrides,
  };
}

function positionRow(overrides: PositionRow = {}): PositionRow {
  return {
    id: 'pos-pred-1',
    userId,
    marketId,
    side: true,
    shares: 100,
    avgPrice: 0.5,
    cashCostBasis: 50.05,
    ...overrides,
  };
}

async function getPositions(): Promise<{
  marketPositions: Array<{ unrealizedPnL: number }>;
  perpPositions: unknown[];
  totalPnL: number;
}> {
  const result = (await FeedAgentExecutor.executeDirectly(
    'portfolio.get_positions',
    {},
    userId
  )) as {
    marketPositions: Array<{ unrealizedPnL: number }>;
    perpPositions: unknown[];
    totalPnL: number;
  };
  return result;
}

describe('A2A portfolio.get_positions marks prediction PnL against gross cash cost', () => {
  test('counts the entry fee as a cost, not profit, at an unchanged price', async () => {
    // YES price = noShares / total = 0.50. 100 shares at net avgPrice
    // 0.50 cost 50.00 net; the gross cash paid was 50.05 (0.1% entry
    // fee). The old formula reported 100 * (0.50 - 0.50) = 0.
    currentMarketRows = [marketRow()];
    currentPositionRows = [positionRow()];
    const result = await getPositions();
    expect(result.marketPositions).toHaveLength(1);
    expect(result.marketPositions[0]?.unrealizedPnL).toBeCloseTo(-0.05, 6);
    expect(result.totalPnL).toBeCloseTo(-0.05, 6);
  });

  test('uses the gross basis after the price moves', async () => {
    // YES price 0.60: mark value 60.00, gross basis 50.05.
    currentMarketRows = [marketRow({ yesShares: 4000, noShares: 6000 })];
    currentPositionRows = [positionRow()];
    const result = await getPositions();
    expect(result.marketPositions[0]?.unrealizedPnL).toBeCloseTo(9.95, 6);
    expect(result.totalPnL).toBeCloseTo(9.95, 6);
  });

  test('falls back to the gross-up estimate for legacy rows without cashCostBasis', async () => {
    // Legacy fallback: ROUND(50.00 / (1 - 0.001), 2) = 50.05.
    currentMarketRows = [marketRow()];
    currentPositionRows = [positionRow({ cashCostBasis: null })];
    const result = await getPositions();
    expect(result.marketPositions[0]?.unrealizedPnL).toBeCloseTo(-0.05, 6);
    expect(result.totalPnL).toBeCloseTo(-0.05, 6);
  });

  test('applies the gross basis to the NO side as well', async () => {
    // NO price = yesShares / total = 0.50.
    currentMarketRows = [marketRow()];
    currentPositionRows = [positionRow({ side: false })];
    const result = await getPositions();
    expect(result.marketPositions[0]?.unrealizedPnL).toBeCloseTo(-0.05, 6);
    expect(result.totalPnL).toBeCloseTo(-0.05, 6);
  });
});
