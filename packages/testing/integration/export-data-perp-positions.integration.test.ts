/**
 * GET /api/users/export-data against a real database: the settings page
 * promises "Export all your personal data, including profile information,
 * posts, comments, trading history, and more", and the route documents
 * itself as exporting "all user data ... and all associated data".
 *
 * Perp positions live in their own table (PerpPosition) and are a core
 * part of a user's trading history, but the export only ever queried the
 * prediction Position table — a user whose trading was entirely in perps
 * received an export with no positions at all. This suite checks that the
 * trading section carries the user's perp positions with their stored
 * values, and none of anyone else's.
 *
 * Auth uses the dev x-dev-user-id header (NODE_ENV=test). The only stub is
 * the `server-only` marker package; every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, perpPositions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ExportBody = {
  trading: {
    perp_positions?: Array<{
      id: string;
      ticker: string;
      side: string;
      entryPrice: number;
      size: number;
      realizedPnL: number | null;
    }>;
  };
};

let GET: typeof import('../../../apps/web/src/app/api/users/export-data/route').GET;

let userId: string;
let otherId: string;
let openPerpId: string;
let closedPerpId: string;
let otherPerpId: string;

async function fetchExport(uid: string) {
  const request = new NextRequest(
    new Request('http://localhost/api/users/export-data'),
    { headers: { 'x-dev-user-id': uid } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as ExportBody | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/export-data/route'
  ));

  [userId, otherId, openPerpId, closedPerpId, otherPerpId] = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
    await generateSnowflakeId(),
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const now = new Date();

  await db.insert(users).values([
    {
      id: userId,
      username: `f34p-${userId}`,
      displayName: 'Export Perp Fixture User',
      updatedAt: now,
    },
    {
      id: otherId,
      username: `f34q-${otherId}`,
      displayName: 'Export Perp Fixture Other',
      updatedAt: now,
    },
  ]);

  await db.insert(perpPositions).values([
    {
      id: openPerpId,
      userId,
      ticker: 'F34AAA',
      organizationId: 'f34-org',
      side: 'long',
      entryPrice: 10.5,
      currentPrice: 11.25,
      size: 100,
      leverage: 5,
      liquidationPrice: 8.4,
      unrealizedPnL: 75,
      unrealizedPnLPercent: 7.14,
      lastUpdated: now,
    },
    {
      id: closedPerpId,
      userId,
      ticker: 'F34BBB',
      organizationId: 'f34-org',
      side: 'short',
      entryPrice: 20,
      currentPrice: 21,
      size: 50,
      leverage: 2,
      liquidationPrice: 30,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      lastUpdated: now,
      closedAt: now,
      realizedPnL: -42.5,
    },
    {
      id: otherPerpId,
      userId: otherId,
      ticker: 'F34CCC',
      organizationId: 'f34-org',
      side: 'long',
      entryPrice: 5,
      currentPrice: 5,
      size: 10,
      leverage: 1,
      liquidationPrice: 4,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      lastUpdated: now,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(perpPositions)
    .where(inArray(perpPositions.id, [openPerpId, closedPerpId, otherPerpId]));
  await db.delete(users).where(inArray(users.id, [userId, otherId]));
});

describe('GET /api/users/export-data perp positions', () => {
  it('includes every perp position the user holds or held', async () => {
    const { status, body } = await fetchExport(userId);
    expect(status).toBe(200);
    const perps = body?.trading.perp_positions ?? [];
    const ids = new Set(perps.map((p) => p.id));
    expect(ids.has(openPerpId)).toBe(true);
    expect(ids.has(closedPerpId)).toBe(true);
    expect(perps.length).toBe(2);
  });

  it('keeps stored perp values unchanged and excludes other users', async () => {
    const { body } = await fetchExport(userId);
    const perps = body?.trading.perp_positions ?? [];
    const closed = perps.find((p) => p.id === closedPerpId);
    expect(closed?.ticker).toBe('F34BBB');
    expect(closed?.side).toBe('short');
    expect(closed?.entryPrice).toBe(20);
    expect(closed?.size).toBe(50);
    expect(closed?.realizedPnL).toBe(-42.5);
    expect(perps.some((p) => p.id === otherPerpId)).toBe(false);
  });
});
