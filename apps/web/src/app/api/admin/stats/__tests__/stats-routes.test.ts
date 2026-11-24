import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as actualApi from '@feed/api';
import * as actualDb from '@feed/db';
import { NextResponse } from 'next/server';

const rawSql: string[] = [];

const countCalls: unknown[] = [];

const model = {
  count: async (...args: unknown[]) => {
    countCalls.push(args[0]);
    return 0;
  },
  aggregate: async () => ({ _sum: {}, _avg: {}, _count: 0 }),
  findMany: async () => [],
  groupBy: async () => [],
  findFirst: async () => null,
};

const fakeDb = new Proxy(
  {
    $queryRaw: async (strings: TemplateStringsArray) => {
      rawSql.push(strings.join('?'));
      return [];
    },
  },
  {
    get(target, prop) {
      if (prop === '$queryRaw') return target.$queryRaw;
      return model;
    },
  }
);

mock.module('@feed/db', () => ({ ...actualDb, db: fakeDb }));

mock.module('@feed/api', () => ({
  ...actualApi,
  applyRateLimit: () => ({ allowed: true }),
  requirePermission: async () => ({ userId: 'admin-1' }),
  successResponse: (data: object, status = 200) =>
    NextResponse.json(data, { status }),
  withErrorHandling: (handler: (req: Request) => Promise<Response>) => handler,
}));

const trading = (await import('../trading/route')).GET;
const heatmap = (await import('../heatmap/route')).GET;

const req = (path: string) => new Request(`http://localhost${path}`) as never;

describe('admin stats routes', () => {
  beforeEach(() => {
    rawSql.length = 0;
    countCalls.length = 0;
  });

  it('activeMarkets excludes markets past their deadline', async () => {
    const before = Date.now();
    const res = (await trading(req('/api/admin/stats/trading'))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overview: { activeMarkets: number };
    };
    expect(body.overview.activeMarkets).toBe(0);
    const activeCall = countCalls.find(
      (args) =>
        args &&
        typeof args === 'object' &&
        (args as { where?: { resolved?: boolean } }).where?.resolved === false
    ) as
      | { where?: { resolved?: boolean; endDate?: { gte?: unknown } } }
      | undefined;
    // Active means open for trading: unresolved and not past its deadline.
    // An expired market stays unresolved until settlement runs, but buys on
    // it are refused, so the admin overview must not count it — same
    // predicate as the main admin stats route and MCP get_markets.
    expect(activeCall).toBeDefined();
    const gte = activeCall?.where?.endDate?.gte;
    expect(gte).toBeInstanceOf(Date);
    expect((gte as Date).getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect((gte as Date).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('trading queries the transaction types the ledger actually writes', async () => {
    const res = (await trading(
      req('/api/admin/stats/trading?includeTimeSeries=true')
    )) as Response;
    expect(res.status).toBe(200);
    const all = rawSql.join('\n');
    expect(all).toContain("'pred_buy'");
    expect(all).not.toContain('prediction_buy');
    expect(all).not.toContain('ABS(SUM(');
  });

  it('rejects a lone future startDate (inverted effective range)', async () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const res = (await trading(
      req(`/api/admin/stats/trading?startDate=${future}`)
    )) as Response;
    expect(res.status).toBe(400);
  });

  it('heatmap validates the effective window after defaults', async () => {
    const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
    const res = (await heatmap(
      req(`/api/admin/stats/heatmap?startDate=${old}`)
    )) as Response;
    expect(res.status).toBe(400);
  });
});
