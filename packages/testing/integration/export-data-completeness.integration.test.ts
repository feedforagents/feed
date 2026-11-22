// The existing account export must return a complete, owner-scoped JSON file.
import { beforeAll, describe, expect, it, mock } from 'bun:test';

import {
  balanceTransactions,
  comments,
  db,
  notifications,
  perpPositions,
  pointsTransactions,
  positions,
  posts,
  sql,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

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
const myPostIds: string[] = [];

const secret = 'local-disposable-export-test-signing-key';
const signingKey = new TextEncoder().encode(secret);

async function exportResponse(uid?: string) {
  const headers = new Headers();
  if (uid) {
    const token = await new SignJWT({ userId: uid })
      .setIssuer('steward')
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(signingKey);
    headers.set('Authorization', `Bearer ${token}`);
  }
  return GET(
    new NextRequest('http://localhost/api/users/export-data', { headers })
  );
}

async function fetchExport(uid: string) {
  const response = await exportResponse(uid);
  return {
    status: response.status,
    body: (await response.json()) as ExportBody,
  };
}

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = secret;
  mock.module('server-only', () => ({}));

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
        stewardId: userId,
        username: `f34u-${userId}`,
        displayName: 'Export Fixture User',
        updatedAt: now,
      },
      {
        id: otherId,
        stewardId: otherId,
        username: `f34o-${otherId}`,
        displayName: 'Export Fixture Other',
        updatedAt: now,
      },
    ]);

    // Notifications: 150 for the exporter, 5 for someone else.
    const notifRows: Array<typeof notifications.$inferInsert> = [];
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
    // Force a timestamp tie across pages that cannot round trip through Date.
    await db.execute(sql`
    update ${notifications}
    set "createdAt" = ${now.toISOString()}::timestamp + interval '123 microseconds'
    where "userId" = ${userId}
  `);

    // Trading fees paid by the exporter: 150. Fees earned as referrer: 150
    // (paid by the other user). Other user's own fees: 3.
    const feeRows: Array<typeof tradingFees.$inferInsert> = [];
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
    for (const [i, amount] of balAmounts.entries()) {
      const id = await generateSnowflakeId();
      await db.insert(balanceTransactions).values({
        id,
        userId,
        type: 'f34_probe',
        amount,
        balanceBefore: '0.00',
        balanceAfter: amount,
        createdAt: new Date(now.getTime() - i * 60_000),
      });
    }
    for (let i = 0; i < 2; i++) {
      const id = await generateSnowflakeId();
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
    const postId = myPostIds[0];
    if (!postId) throw new Error('Missing fixture post');
    const commentId = await generateSnowflakeId();
    await db.insert(comments).values({
      id: commentId,
      authorId: userId,
      postId,
      content: 'f34 comment',
      updatedAt: now,
    });
  });

  describe('GET /api/users/export-data completeness', () => {
    it('exports every notification, not just the most recent 100', async () => {
      const { status, body } = await fetchExport(userId);
      expect(status).toBe(200);
      expect(body?.notifications.length).toBe(NOTIFICATION_COUNT);
      expect(body.notifications.map((n) => n.id)).toEqual(
        [...myNotificationIds].sort().reverse()
      );
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
      const ids = new Set(
        body?.financial.referral_fees_earned.map((f) => f.id)
      );
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
    it('streams a cancellable signed download and rejects unauthenticated requests', async () => {
      expect((await exportResponse()).status).toBe(401);
      const other = await fetchExport(otherId);
      expect(other.body.export_info.user_id).toBe(otherId);
      expect(other.body.notifications.map((row) => row.id).sort()).toEqual(
        [...otherNotificationIds].sort()
      );

      const response = await exportResponse(userId);
      expect(response.headers.get('Content-Disposition')).toStartWith(
        'attachment;'
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Export stream is missing');
      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value?.byteLength).toBeLessThan(256);
      } finally {
        await reader.cancel();
      }
    });
  });
} else {
  it('runs account export cases against a disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'export-data-completeness',
      file: 'packages/testing/integration/export-data-completeness.integration.test.ts',
      cases: [
        'GET /api/users/export-data completeness > exports every notification, not just the most recent 100',
        'GET /api/users/export-data completeness > exports every trading fee the user paid',
        'GET /api/users/export-data completeness > exports every referral fee the user earned',
        "GET /api/users/export-data completeness > keeps stored values unchanged and includes no one else's rows",
        'GET /api/users/export-data completeness > streams a cancellable signed download and rejects unauthenticated requests',
      ],
    });
  }, 300_000);
}
