/**
 * GET /api/users/export-data against a real database: the settings page
 * promises "Export all your personal data ... You will receive a JSON file
 * containing all your data", and the route documents itself as exporting
 * "all user data ... and all associated data" for GDPR data portability.
 *
 * This suite seeds a user whose history exceeds one hundred rows in the
 * sections the route assembles and checks that the export is complete
 * (nothing truncated, no section missing), uncontaminated (no other user's
 * rows), and faithful (stored values survive unchanged).
 *
 * Auth uses the dev x-dev-user-id header (NODE_ENV=test). The only stub is
 * the `server-only` marker package; every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  comments,
  db,
  eq,
  inArray,
  notifications,
  perpPositions,
  pointsTransactions,
  positions,
  posts,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ExportBody = {
  export_info: { user_id: string };
  content: {
    posts: Array<{ id: string }>;
    comments: Array<{ id: string }>;
  };
  trading: {
    positions: Array<{ id: string; shares: string; avgPrice: string }>;
    balance_transactions: Array<{ id: string; amount: string }>;
  };
  points_and_reputation: {
    points_transactions: Array<{ id: string; amount: number }>;
  };
  financial: {
    trading_fees_paid: Array<{ id: string }>;
    referral_fees_earned: Array<{ id: string }>;
  };
  notifications: Array<{ id: string }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/export-data/route').GET;

let userId: string;
let otherId: string;
const NOTIFICATION_COUNT = 150;
const FEE_COUNT = 150;
const myNotificationIds: string[] = [];
const otherNotificationIds: string[] = [];
const myFeePaidIds: string[] = [];
const myFeeEarnedIds: string[] = [];
const otherFeeIds: string[] = [];
const myPerpIds: string[] = [];
const otherPerpIds: string[] = [];
let myPositionId: string;
const myBalanceIds: string[] = [];
const myPointsIds: string[] = [];
const myPostIds: string[] = [];
const myCommentIds: string[] = [];

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

  [userId, otherId] = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const now = new Date();

  await db.insert(users).values([
    {
      id: userId,
      username: `f34u-${userId}`,
      displayName: 'Export Fixture User',
      updatedAt: now,
    },
    {
      id: otherId,
      username: `f34o-${otherId}`,
      displayName: 'Export Fixture Other',
      updatedAt: now,
    },
  ]);

  // Notifications: 150 for the exporter, 5 for someone else.
  const notifRows = [];
  for (let i = 0; i < NOTIFICATION_COUNT; i++) {
    const id = await generateSnowflakeId();
    myNotificationIds.push(id);
    notifRows.push({
      id,
      userId,
      type: 'f34_export_probe',
      title: `probe ${i}`,
      message: `probe notification ${i}`,
      createdAt: new Date(now.getTime() - (NOTIFICATION_COUNT - i) * 60_000),
    });
  }
  for (let i = 0; i < 5; i++) {
    const id = await generateSnowflakeId();
    otherNotificationIds.push(id);
    notifRows.push({
      id,
      userId: otherId,
      type: 'f34_export_probe',
      title: `other ${i}`,
      message: `other notification ${i}`,
      createdAt: new Date(now.getTime() - i * 60_000),
    });
  }
  await db.insert(notifications).values(notifRows);

  // Trading fees paid by the exporter: 150. Fees earned as referrer: 150
  // (paid by the other user). Other user's own fees: 3.
  const feeRows = [];
  for (let i = 0; i < FEE_COUNT; i++) {
    const id = await generateSnowflakeId();
    myFeePaidIds.push(id);
    feeRows.push({
      id,
      userId,
      tradeType: 'prediction',
      feeAmount: '1.00',
      platformFee: '0.80',
      referrerFee: '0.20',
      createdAt: new Date(now.getTime() - (FEE_COUNT - i) * 60_000),
    });
  }
  for (let i = 0; i < FEE_COUNT; i++) {
    const id = await generateSnowflakeId();
    myFeeEarnedIds.push(id);
    feeRows.push({
      id,
      userId: otherId,
      tradeType: 'prediction',
      feeAmount: '2.00',
      platformFee: '1.60',
      referrerFee: '0.40',
      referrerId: userId,
      createdAt: new Date(now.getTime() - (FEE_COUNT - i) * 60_000),
    });
  }
  for (let i = 0; i < 3; i++) {
    const id = await generateSnowflakeId();
    otherFeeIds.push(id);
    feeRows.push({
      id,
      userId: otherId,
      tradeType: 'prediction',
      feeAmount: '3.00',
      platformFee: '2.40',
      referrerFee: '0.60',
      createdAt: new Date(now.getTime() - i * 60_000),
    });
  }
  await db.insert(tradingFees).values(feeRows);

  // Perp positions: two for the exporter (one open, one closed), one other.
  const perpOpen = await generateSnowflakeId();
  const perpClosed = await generateSnowflakeId();
  const perpOther = await generateSnowflakeId();
  myPerpIds.push(perpOpen, perpClosed);
  otherPerpIds.push(perpOther);
  await db.insert(perpPositions).values([
    {
      id: perpOpen,
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
      id: perpClosed,
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
      id: perpOther,
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

  // One resolved prediction position with distinctive stored values.
  myPositionId = await generateSnowflakeId();
  await db.insert(positions).values({
    id: myPositionId,
    userId,
    marketId: 'f34-market',
    side: true,
    shares: '10.500000',
    avgPrice: '0.420000',
    amount: '4.41',
    pnl: '12.34',
    status: 'resolved',
    updatedAt: now,
  });

  // Balance + points ledger rows with distinctive amounts.
  const balAmounts = ['100.00', '-25.50', '7.25'];
  for (let i = 0; i < balAmounts.length; i++) {
    const id = await generateSnowflakeId();
    myBalanceIds.push(id);
    await db.insert(balanceTransactions).values({
      id,
      userId,
      type: 'f34_probe',
      amount: balAmounts[i],
      balanceBefore: '0.00',
      balanceAfter: balAmounts[i],
      createdAt: new Date(now.getTime() - i * 60_000),
    });
  }
  for (let i = 0; i < 2; i++) {
    const id = await generateSnowflakeId();
    myPointsIds.push(id);
    await db.insert(pointsTransactions).values({
      id,
      userId,
      amount: 111 * (i + 1),
      pointsBefore: 0,
      pointsAfter: 111 * (i + 1),
      reason: 'f34_probe',
      createdAt: new Date(now.getTime() - i * 60_000),
    });
  }

  // Content rows.
  for (let i = 0; i < 2; i++) {
    const id = await generateSnowflakeId();
    myPostIds.push(id);
    await db.insert(posts).values({
      id,
      authorId: userId,
      type: 'post',
      content: `f34 post ${i}`,
      timestamp: now,
    });
  }
  const commentId = await generateSnowflakeId();
  myCommentIds.push(commentId);
  await db.insert(comments).values({
    id: commentId,
    authorId: userId,
    postId: myPostIds[0],
    content: 'f34 comment',
    updatedAt: now,
  });
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(
      inArray(notifications.id, [...myNotificationIds, ...otherNotificationIds])
    );
  await db
    .delete(tradingFees)
    .where(
      inArray(tradingFees.id, [
        ...myFeePaidIds,
        ...myFeeEarnedIds,
        ...otherFeeIds,
      ])
    );
  await db
    .delete(perpPositions)
    .where(inArray(perpPositions.id, [...myPerpIds, ...otherPerpIds]));
  await db.delete(positions).where(eq(positions.id, myPositionId));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.id, myBalanceIds));
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.id, myPointsIds));
  await db.delete(comments).where(inArray(comments.id, myCommentIds));
  await db.delete(posts).where(inArray(posts.id, myPostIds));
  await db.delete(users).where(inArray(users.id, [userId, otherId]));
});

describe('GET /api/users/export-data completeness', () => {
  it('exports every notification, not just the most recent 100', async () => {
    const { status, body } = await fetchExport(userId);
    expect(status).toBe(200);
    expect(body?.notifications.length).toBe(NOTIFICATION_COUNT);
    const ids = new Set(body?.notifications.map((n) => n.id));
    for (const id of myNotificationIds) expect(ids.has(id)).toBe(true);
  });

  it('exports every trading fee the user paid', async () => {
    const { body } = await fetchExport(userId);
    expect(body?.financial.trading_fees_paid.length).toBe(FEE_COUNT);
    const ids = new Set(body?.financial.trading_fees_paid.map((f) => f.id));
    for (const id of myFeePaidIds) expect(ids.has(id)).toBe(true);
  });

  it('exports every referral fee the user earned', async () => {
    const { body } = await fetchExport(userId);
    expect(body?.financial.referral_fees_earned.length).toBe(FEE_COUNT);
    const ids = new Set(body?.financial.referral_fees_earned.map((f) => f.id));
    for (const id of myFeeEarnedIds) expect(ids.has(id)).toBe(true);
  });

  it("keeps stored values unchanged and includes no one else's rows", async () => {
    const { body } = await fetchExport(userId);
    const whole = JSON.stringify(body ?? {});
    for (const id of [
      ...otherNotificationIds,
      ...otherFeeIds,
      ...otherPerpIds,
    ]) {
      expect(whole).not.toContain(id);
    }
    const pos = body?.trading.positions.find((p) => p.id === myPositionId);
    expect(pos?.shares).toBe('10.500000');
    expect(pos?.avgPrice).toBe('0.420000');
    const amounts = new Set(
      body?.trading.balance_transactions.map((t) => t.amount)
    );
    expect(amounts).toEqual(new Set(['100.00', '-25.50', '7.25']));
    const pointAmounts = new Set(
      body?.points_and_reputation.points_transactions.map((t) => t.amount)
    );
    expect(pointAmounts).toEqual(new Set([111, 222]));
    expect(body?.content.posts.length).toBe(2);
    expect(body?.content.comments.length).toBe(1);
  });
});
