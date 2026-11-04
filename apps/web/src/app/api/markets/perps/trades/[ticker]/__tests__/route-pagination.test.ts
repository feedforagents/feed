import { describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const baseTime = Date.UTC(2026, 0, 1);

function at(seconds: number): Date {
  return new Date(baseTime + seconds * 1_000);
}

function user(id: string) {
  return {
    id,
    username: id,
    displayName: id,
    profileImageUrl: null,
    isActor: id.startsWith('actor-'),
  };
}

const users = [
  user('user-p1'),
  user('user-p2'),
  user('user-p3'),
  user('user-p4'),
];

const positions: Row[] = [
  ['p1', 100],
  ['p2', 90],
  ['p3', 80],
  ['p4', 70],
].map(([id, seconds]) => ({
  id,
  userId: `user-${id}`,
  side: 'long',
  size: 1,
  leverage: 2,
  entryPrice: 100,
  currentPrice: 101,
  unrealizedPnL: 1,
  liquidationPrice: 50,
  openedAt: at(Number(seconds)),
  closedAt: null,
  ticker: 'ABC',
  organizationId: 'abc-org',
}));

const npcTrades: Row[] = [
  ['n1', 95],
  ['n2', 85],
  ['n3', 75],
  ['n4', 65],
].map(([id, seconds]) => ({
  id,
  npcActorId: `actor-${id}`,
  marketType: 'perp',
  ticker: 'ABC',
  action: 'open_long',
  side: 'long',
  amount: 10,
  price: 100,
  sentiment: 0.5,
  reason: 'fixture',
  executedAt: at(Number(seconds)),
}));

const balanceTransactions: Row[] = [
  {
    id: 'b1',
    type: 'perp_close',
    amount: 10,
    userId: 'user-p4',
    createdAt: at(105),
    relatedId: 'p4',
    description: 'Close p4',
  },
  {
    id: 'b2',
    type: 'perp_open',
    amount: 10,
    userId: 'user-p3',
    createdAt: at(55),
    relatedId: 'p3',
    description: 'Open p3',
  },
];

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  if (Array.isArray(where.OR)) {
    return where.OR.some((candidate) =>
      matches(row, candidate as Row | undefined)
    );
  }

  return Object.entries(where).every(([field, condition]) => {
    if (
      condition !== null &&
      typeof condition === 'object' &&
      'in' in condition &&
      Array.isArray(condition.in)
    ) {
      return condition.in.includes(row[field]);
    }
    return row[field] === condition;
  });
}

function applySelect(row: Row, select: Row | undefined): Row {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((field) => select[field] === true)
      .map((field) => [field, row[field]])
  );
}

function findMany(rows: Row[]) {
  return async (options: Row = {}) => {
    const orderBy = (options.orderBy ?? {}) as Row;
    const [sortField, direction] = Object.entries(orderBy)[0] ?? [];
    const result = rows
      .filter((row) => matches(row, options.where as Row | undefined))
      .sort((a, b) => {
        if (!sortField) return 0;
        const left = a[sortField];
        const right = b[sortField];
        if (!(left instanceof Date) || !(right instanceof Date)) return 0;
        return direction === 'desc'
          ? right.getTime() - left.getTime()
          : left.getTime() - right.getTime();
      })
      .slice(
        Number(options.skip ?? 0),
        options.take === undefined
          ? undefined
          : Number(options.skip ?? 0) + Number(options.take)
      )
      .map((row) => applySelect(row, options.select as Row | undefined));
    return result;
  };
}

function count(rows: Row[]) {
  return async (options: Row = {}) =>
    rows.filter((row) => matches(row, options.where as Row | undefined)).length;
}

const db = {
  organizationState: {
    findUnique: async () => ({ currentPrice: 123 }),
  },
  perpPosition: {
    findMany: findMany(positions),
    count: count(positions),
  },
  npcTrade: {
    findMany: findMany(npcTrades),
    count: count(npcTrades),
  },
  balanceTransaction: {
    findMany: findMany(balanceTransactions),
    count: count(balanceTransactions),
  },
  user: {
    findMany: findMany(users),
  },
};

mock.module('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

mock.module('@feed/api', () => ({
  addPublicReadHeaders: mock(),
  getCache: async () => null,
  publicRateLimit: async () => ({
    error: null,
    rateLimitInfo: { limit: 60, remaining: 59 },
  }),
  setCache: async () => undefined,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({ db }));

mock.module('@feed/engine', () => ({
  StaticDataRegistry: {
    getAllOrganizations: () => [
      {
        id: 'abc-org',
        name: 'ABC Corp',
        type: 'company',
        ticker: 'ABC',
      },
    ],
    getActor: (id: string) => ({
      id,
      name: id,
      profileImageUrl: null,
    }),
  },
}));

mock.module('@feed/shared', () => ({
  logger: { info: mock(), debug: mock(), warn: mock(), error: mock() },
}));

const { GET } = await import('../route');

async function fetchPage(offset: number) {
  const response = (await GET(
    new Request(
      `http://localhost/api/markets/perps/trades/ABC?limit=2&offset=${offset}`
    ) as unknown as NextRequest,
    { params: Promise.resolve({ ticker: 'ABC' }) }
  )) as Response;
  return response.json() as Promise<{
    trades: { id: string }[];
    total: number;
    hasMore: boolean;
  }>;
}

describe('GET /api/markets/perps/trades/[ticker] merged pagination', () => {
  it('returns every merged trade exactly once with a stable total', async () => {
    const pages = [
      await fetchPage(0),
      await fetchPage(2),
      await fetchPage(4),
      await fetchPage(6),
      await fetchPage(8),
    ];

    expect(pages.map((page) => page.trades.map((trade) => trade.id))).toEqual([
      ['b1', 'p1'],
      ['n1', 'p2'],
      ['n2', 'p3'],
      ['n3', 'p4'],
      ['n4', 'b2'],
    ]);
    expect(pages.map((page) => page.total)).toEqual([10, 10, 10, 10, 10]);
    expect(pages.map((page) => page.hasMore)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('reports the same total and terminal hasMore on every page', async () => {
    const pages = [await fetchPage(0), await fetchPage(2), await fetchPage(8)];

    expect(pages.map((page) => page.total)).toEqual([10, 10, 10]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
  });
});
