/**
 * GET /api/users/[userId]/reputation-history against a real database: the
 * points ledger list is the only official explanation of a user's
 * reputation balance, and every row carries pointsBefore/pointsAfter so
 * the list reads as one chain from the current balance back through every
 * change. Rows written in one bulk operation share the exact same
 * createdAt (Postgres now() is the transaction timestamp, and batch
 * writers insert many rows in one statement). The route orders by
 * createdAt alone, so inside a same-timestamp batch the returned order —
 * and, at the 100-row cap, which batch rows are returned at all — is
 * whatever the heap/index happens to yield: the chain visibly breaks
 * (a row's pointsBefore does not continue the previous row's
 * pointsAfter), and repeated reads can disagree.
 *
 * The ledger rows' ids are snowflakes (generateSnowflakeId), which are
 * issued in creation order, so (createdAt desc, id desc) is a total
 * order that always matches the before/after chain. Sibling list fixes
 * use the same total-order shape (#1728 trades, #1734 prediction
 * markets).
 *
 * Auth uses the existing integration-test bearer; the only stub is the
 * `server-only` marker package. Everything else runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, pointsTransactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type NormalizedTx = {
  id: string;
  amount: number;
  pointsBefore: number;
  pointsAfter: number;
  reason: string;
  createdAt: string;
};

type HistoryResponse = { transactions: NormalizedTx[] };

// The canonical route spreads the service item (reputationDelta /
// reputationBefore / reputationAfter); the legacy alias remaps the same
// rows to amount / pointsBefore / pointsAfter. Normalize both shapes.
function normalize(body: unknown): HistoryResponse {
  const raw = (body as { transactions?: Array<Record<string, unknown>> })
    ?.transactions;
  return {
    transactions: (raw ?? []).map((t) => ({
      id: String(t.id),
      amount: Number(t.amount ?? t.reputationDelta),
      pointsBefore: Number(t.pointsBefore ?? t.reputationBefore),
      pointsAfter: Number(t.pointsAfter ?? t.reputationAfter),
      reason: String(t.reason),
      createdAt: String(t.createdAt),
    })),
  };
}

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/reputation-history/route').GET;
let GET_LEGACY: typeof import('../../../apps/web/src/app/api/users/[userId]/points-history/route').GET;

let ownerId: string;
let otherId: string;
const fixtureUserIds: string[] = [];

// Chain layout for the owner (link k: before = (k-1)*10, after = k*10):
//   links   1..60  — distinct timestamps, one minute apart
//   links  61..150 — ONE bulk timestamp (single multi-row insert)
//   links 151..180 — distinct timestamps, one hour apart
// Final balance 1800. The route caps at 100 rows, so the visible window
// is links 81..180: links 81..150 are the newest 70 links of the bulk
// batch — exactly the rows whose selection and order a createdAt-only
// sort leaves undefined.
const TOTAL_LINKS = 180;
const PAGE = 100;

async function fetchHistory(
  handler: typeof GET,
  asUser: string,
  targetUser: string
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${targetUser}/reputation-history`),
    { headers: { authorization: `Bearer steward:test:${asUser}` } }
  );
  const response = await handler(request, {
    params: Promise.resolve({ userId: targetUser }),
  });
  const raw = await response.json().catch(() => null);
  const body =
    response.status === 200 ? normalize(raw) : (raw as { error?: unknown });
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/reputation-history/route'
  ));
  ({ GET: GET_LEGACY } = await import(
    '../../../apps/web/src/app/api/users/[userId]/points-history/route'
  ));

  ownerId = await generateSnowflakeId();
  otherId = await generateSnowflakeId();
  fixtureUserIds.push(ownerId, otherId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: ownerId,
      username: `f26o-${ownerId}`,
      displayName: 'Points History Fixture Owner',
      reputationPoints: TOTAL_LINKS * 10,
      updatedAt: now,
    },
    {
      id: otherId,
      username: `f26x-${otherId}`,
      displayName: 'Points History Fixture Other',
      reputationPoints: 50,
      updatedAt: now,
    },
  ]);

  const base = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const bulkAt = new Date(base.getTime() + 120 * 60_000);

  type Row = {
    id: string;
    userId: string;
    amount: number;
    pointsBefore: number;
    pointsAfter: number;
    reason: string;
    createdAt: Date;
  };
  const rows: Row[] = [];
  for (let k = 1; k <= TOTAL_LINKS; k++) {
    let createdAt: Date;
    if (k <= 60) {
      createdAt = new Date(base.getTime() + k * 60_000);
    } else if (k <= 150) {
      createdAt = bulkAt;
    } else {
      createdAt = new Date(bulkAt.getTime() + (k - 150) * 60 * 60_000);
    }
    rows.push({
      id: await generateSnowflakeId(),
      userId: ownerId,
      amount: 10,
      pointsBefore: (k - 1) * 10,
      pointsAfter: k * 10,
      reason: 'award',
      createdAt,
    });
  }

  // Distinct-timestamp links go in individually; the 90 bulk links go in
  // as ONE multi-row insert, exactly like a batch writer produces them.
  for (const row of rows.slice(0, 60)) {
    await db.insert(pointsTransactions).values(row);
  }
  await db.insert(pointsTransactions).values(rows.slice(60, 150));
  for (const row of rows.slice(150)) {
    await db.insert(pointsTransactions).values(row);
  }

  // The other user has a small ledger of their own (mixing guard).
  for (let k = 1; k <= 5; k++) {
    await db.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId: otherId,
      amount: 10,
      pointsBefore: (k - 1) * 10,
      pointsAfter: k * 10,
      reason: 'award',
      createdAt: new Date(base.getTime() + k * 60_000),
    });
  }
});

afterAll(async () => {
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, ownerId));
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, otherId));
  for (const id of fixtureUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('points history read path', () => {
  it('returns the visible window as one unbroken before/after chain', async () => {
    const { status, body } = await fetchHistory(GET, ownerId, ownerId);
    expect(status).toBe(200);
    const txs = (body as HistoryResponse).transactions;
    expect(txs.length).toBe(PAGE);

    // Newest first: the window must be links 180 down to 81, in order.
    for (let i = 0; i < txs.length; i++) {
      const link = TOTAL_LINKS - i;
      expect(txs[i]!.pointsBefore).toBe((link - 1) * 10);
      expect(txs[i]!.pointsAfter).toBe(link * 10);
    }
  });

  it('returns an identical sequence on repeated reads', async () => {
    const first = await fetchHistory(GET, ownerId, ownerId);
    const second = await fetchHistory(GET, ownerId, ownerId);
    const firstIds = (first.body as HistoryResponse).transactions.map(
      (t) => t.id
    );
    const secondIds = (second.body as HistoryResponse).transactions.map(
      (t) => t.id
    );
    expect(secondIds).toEqual(firstIds);
  });

  it('legacy alias returns the same sequence as the canonical route', async () => {
    const canonical = await fetchHistory(GET, ownerId, ownerId);
    const legacy = await fetchHistory(GET_LEGACY, ownerId, ownerId);
    expect(legacy.status).toBe(200);
    const canonicalIds = (canonical.body as HistoryResponse).transactions.map(
      (t) => t.id
    );
    const legacyIds = (legacy.body as HistoryResponse).transactions.map(
      (t) => t.id
    );
    expect(legacyIds).toEqual(canonicalIds);
  });

  it('does not expose another user’s ledger', async () => {
    const { status } = await fetchHistory(GET, otherId, ownerId);
    expect(status).toBe(403);

    const own = await fetchHistory(GET, otherId, otherId);
    expect(own.status).toBe(200);
    const txs = (own.body as HistoryResponse).transactions;
    expect(txs.length).toBe(5);
    for (const tx of txs) {
      expect(tx.pointsAfter).toBeLessThanOrEqual(50);
    }
  });
});
