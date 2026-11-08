import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { db, eq, perpPositions, userPnLSnapshots, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { loadUserPnlHistory } = await import(
  '../../../apps/web/src/lib/wallet/pnlHistory'
);

let userId: string;
let positionId: string;
const now = new Date('2026-11-03T12:30:00.000Z');

beforeAll(async () => {
  userId = await generateSnowflakeId();
  positionId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `test-pnl-${userId}`,
    displayName: 'P&L snapshot fixture',
    lifetimePnL: '20',
    updatedAt: now,
  });
  await db.insert(userPnLSnapshots).values({
    id: `${userId}:history`,
    userId,
    snapshotAt: new Date('2026-11-03T12:00:00.000Z'),
    lifetimePnL: 10,
    unrealizedPnL: 5,
    currentPnL: 15,
  });
  await db.insert(perpPositions).values({
    id: positionId,
    userId,
    organizationId: 'pnl-snapshot-fixture',
    ticker: 'PNL',
    side: 'long',
    entryPrice: 100,
    currentPrice: 110,
    size: 1000,
    leverage: 2,
    liquidationPrice: 50,
    unrealizedPnL: 100,
    unrealizedPnLPercent: 10,
    lastUpdated: now,
  });
});

afterAll(async () => {
  if (!userId) return;
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await db.delete(userPnLSnapshots).where(eq(userPnLSnapshots.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('personal P&L history snapshot', () => {
  it('keeps current, lifetime, unrealized and the live chart point together after a close', async () => {
    const open = await loadUserPnlHistory({ userId, now });
    expect(open.metrics).toEqual({
      userId,
      lifetimePnL: 20,
      unrealizedPnL: 100,
      currentPnL: 120,
    });
    expect(open.points.map((point) => point.value)).toEqual([15, 120]);

    // Model committed settlement: the 100 unrealized gain becomes realized.
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ lifetimePnL: '120' })
        .where(eq(users.id, userId));
      await tx
        .update(perpPositions)
        .set({
          closedAt: now,
          realizedPnL: 100,
          unrealizedPnL: 0,
        })
        .where(eq(perpPositions.id, positionId));
    });

    const closed = await loadUserPnlHistory({
      userId,
      now: new Date(now.getTime() + 1000),
    });
    expect(closed.metrics).toEqual({
      userId,
      lifetimePnL: 120,
      unrealizedPnL: 0,
      currentPnL: 120,
    });
    expect(closed.points.at(-1)?.value).toBe(closed.metrics?.currentPnL);
    expect(closed.points[0]?.value).toBe(15);
    expect(open.metrics?.lifetimePnL).toBe(20);
  });
});
