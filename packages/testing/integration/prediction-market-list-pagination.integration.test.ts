/**
 * Prediction market list pagination reachability.
 *
 * Drives the real GET /api/markets/predictions route with page/limit over a
 * fixture of 300 unresolved markets that all share ONE createdAt value
 * (single multi-row insert — the batch-creation shape: one now() for every
 * row). The list order must be total, so every market is reached exactly
 * once across the page walk; with a createdAt-only order the tied block is
 * returned in a different sequence per page query and the walk duplicates
 * some markets while never reaching others.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { NextRequest } from 'next/server';
import type { GET as PredictionsGet } from '@/app/api/markets/predictions/route';

process.env.NODE_ENV = 'test';
process.env.BUN_ENV = 'test';

import { db, inArray, markets, sql } from '@feed/db';

setDefaultTimeout(120000);

const prefix = `f19-probe-${crypto.randomUUID()}`;
const TIE_COUNT = 300;
const tieIds: string[] = [];
for (let i = 0; i < TIE_COUNT; i++) {
  tieIds.push(`${prefix}-tie-${String(i).padStart(4, '0')}`);
}
const distinctIds: string[] = [];
for (let i = 0; i < 30; i++) {
  distinctIds.push(`${prefix}-distinct-${String(i).padStart(4, '0')}`);
}
const allIds = [...tieIds, ...distinctIds];

let GET: typeof PredictionsGet;

async function fetchPage(page: number, limit: number) {
  const req = new NextRequest(
    `http://localhost/api/markets/predictions?page=${page}&limit=${limit}`
  );
  const res = await GET(req);
  const body = (await res.json()) as {
    questions: Array<{ id: string }>;
    total?: number;
    count: number;
  };
  return body;
}

async function walkAll(limit: number, wanted: string[]) {
  const wantedSet = new Set(wanted);
  const seen: string[] = [];
  // Page budget comes from the route's own `total` (all unresolved markets),
  // not from the fixture size: other groups share the same ordered list.
  let maxPages = 3;
  for (let page = 1; page <= maxPages; page++) {
    const body = await fetchPage(page, limit);
    if (page === 1 && body.total != null) {
      maxPages = Math.ceil(body.total / limit) + 1;
    }
    if (body.questions.length === 0) break;
    seen.push(
      ...body.questions.map((q) => q.id).filter((id) => wantedSet.has(id))
    );
  }
  return seen;
}

beforeAll(async () => {
  const mod = await import('@/app/api/markets/predictions/route');
  GET = mod.GET;

  const sharedCreatedAt = new Date('2026-11-01T00:00:00.000Z');
  const endDate = new Date('2027-01-01T00:00:00.000Z');
  // One multi-row insert: the batch-creation shape (one now() for all rows).
  await db.insert(markets).values(
    tieIds.map((id) => ({
      id,
      question: `Probe tie market ${id}`,
      liquidity: '1000',
      resolved: false,
      endDate,
      createdAt: sharedCreatedAt,
      updatedAt: sharedCreatedAt,
    }))
  );
  // Distinct createdAt control group (newer, so they sort before the ties).
  await db.insert(markets).values(
    distinctIds.map((id, i) => ({
      id,
      question: `Probe distinct market ${id}`,
      liquidity: '1000',
      resolved: false,
      endDate,
      createdAt: new Date(Date.UTC(2026, 10, 2, 0, 0, i)),
      updatedAt: new Date(Date.UTC(2026, 10, 2, 0, 0, i)),
    }))
  );
});

afterAll(async () => {
  await db.delete(markets).where(inArray(markets.id, allIds));
});

describe('prediction market list pagination reachability', () => {
  test('precondition: tie fixture shares exactly one createdAt', async () => {
    const rows = await db
      .select({ c: sql<number>`count(distinct ${markets.createdAt})` })
      .from(markets)
      .where(inArray(markets.id, tieIds));
    expect(Number(rows[0]?.c)).toBe(1);
  });

  test('paging reaches every same-createdAt market exactly once (limit=25, 3 walks)', async () => {
    for (let walk = 0; walk < 3; walk++) {
      const seen = await walkAll(25, tieIds);
      expect(seen.length).toBe(TIE_COUNT);
      expect(new Set(seen).size).toBe(TIE_COUNT);
      expect([...new Set(seen)].sort()).toEqual([...tieIds].sort());
    }
  });

  test('paging reaches every same-createdAt market exactly once (limit=7)', async () => {
    const seen = await walkAll(7, tieIds);
    expect(seen.length).toBe(TIE_COUNT);
    expect(new Set(seen).size).toBe(TIE_COUNT);
  });

  test('distinct-createdAt markets page cleanly (control)', async () => {
    const seen = await walkAll(10, distinctIds);
    expect(seen.length).toBe(30);
    expect(new Set(seen).size).toBe(30);
  });
});
