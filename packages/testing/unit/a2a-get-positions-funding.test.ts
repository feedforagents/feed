import { describe, expect, mock, test } from 'bun:test';

// A2A `portfolio.get_positions` reports each open perp position's stored
// `unrealizedPnL` (price-only) and sums it into `totalPnL`. Accrued funding
// settles only at close (PerpMarketService: realizedPnL = pnl - fundingPaid),
// so a position that owes funding is overstated by exactly fundingPaid —
// the same defect #1649 fixes for the engine portfolio paths, in the
// agent-facing A2A surface that check-pnl / the agent wallet read.
const actualDbModule = await import('@feed/db');

const userId = 'a2a-funding-audit-user';

type PerpRow = Record<string, unknown>;

let currentPerpRows: PerpRow[] = [];

const mockDb = {
  user: {
    findUnique: mock(() => Promise.resolve({ id: userId })),
  },
  position: {
    findMany: mock(() => Promise.resolve([])),
  },
  market: {
    findMany: mock(() => Promise.resolve([])),
  },
  perpPosition: {
    findMany: mock(() => Promise.resolve(currentPerpRows)),
  },
  organizationState: {
    findMany: mock(() => Promise.resolve([{ id: 'org-1', currentPrice: 12 }])),
  },
};

mock.module('@feed/db', () => ({
  ...actualDbModule,
  db: mockDb,
}));

const { FeedAgentExecutor } = await import(
  '../../a2a/src/executors/feed-executor'
);

function perpRow(overrides: PerpRow = {}): PerpRow {
  return {
    id: 'pos-1',
    userId,
    ticker: 'AUDIT',
    organizationId: 'org-1',
    side: 'long',
    entryPrice: 10,
    currentPrice: 12,
    size: 100,
    leverage: 5,
    unrealizedPnL: 20,
    fundingPaid: 5,
    ...overrides,
  };
}

async function getPositions(): Promise<{
  marketPositions: unknown[];
  perpPositions: Array<{ unrealizedPnL: number }>;
  totalPnL: number;
}> {
  const result = (await FeedAgentExecutor.executeDirectly(
    'portfolio.get_positions',
    {},
    userId
  )) as {
    marketPositions: unknown[];
    perpPositions: Array<{ unrealizedPnL: number }>;
    totalPnL: number;
  };
  return result;
}

describe('A2A portfolio.get_positions nets accrued perp funding', () => {
  test('funding owed reduces the reported perp PnL', async () => {
    // unrealizedPnL=20 (price-only), fundingPaid=5 owed at close, so the
    // position is really worth 20 - 5 = 15.
    currentPerpRows = [perpRow()];
    const result = await getPositions();
    expect(result.perpPositions).toHaveLength(1);
    expect(result.perpPositions[0]?.unrealizedPnL).toBe(15);
    expect(result.totalPnL).toBe(15);
  });

  test('funding rebate increases the reported perp PnL', async () => {
    // fundingPaid=-5 means the holder is owed 5 pts of funding at close.
    currentPerpRows = [perpRow({ fundingPaid: -5 })];
    const result = await getPositions();
    expect(result.perpPositions[0]?.unrealizedPnL).toBe(25);
    expect(result.totalPnL).toBe(25);
  });

  test('missing fundingPaid defaults to zero', async () => {
    const row = perpRow();
    delete row.fundingPaid;
    currentPerpRows = [row];
    const result = await getPositions();
    expect(result.perpPositions[0]?.unrealizedPnL).toBe(20);
    expect(result.totalPnL).toBe(20);
  });
});
