import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { db, eq, markets, notifications, positions, users } from '@feed/db';

/**
 * The digest cron must honor the same email preferences as every other
 * notification email: a user who turned email notifications off (or used the
 * unsubscribe link, which clears every flag) must not receive digest emails,
 * and a category that is off (e.g. daily summary) must not be emailed even
 * when the master toggle is on. The in-app digest is not an email and must
 * keep flowing regardless of the email flags.
 */

interface SentEmail {
  userId: string;
  category: string;
}

const sentEmails: SentEmail[] = [];
const actualFeedApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ...actualFeedApi,
  sendNotificationEmail: async (input: {
    userId: string;
    category: string;
  }) => {
    sentEmails.push({ userId: input.userId, category: input.category });
    return { sent: true };
  },
}));

const { deliverDigestForUser, listDigestCandidates } = await import(
  '../../../apps/web/src/lib/services/notification-digest-service'
);

const suffix = crypto.randomUUID();
const unsubUserId = `digest-unsub-${suffix}`;
const optinUserId = `digest-optin-${suffix}`;
const catoffUserId = `digest-catoff-${suffix}`;
const weeklyOffUserId = `digest-weekly-off-${suffix}`;
const allUserIds = [unsubUserId, optinUserId, catoffUserId, weeklyOffUserId];

async function seedUser(params: {
  id: string;
  emailNotificationsEnabled: boolean;
  emailNotificationsDailySummary: boolean;
  emailNotificationsWeeklySummary?: boolean;
  digestFrequency?: 'daily' | 'weekly';
  deliveryChannel?: 'both' | 'email';
}) {
  await db.insert(users).values({
    id: params.id,
    username: params.id,
    email: `${params.id}@example.com`,
    emailVerified: true,
    isTest: true,
    emailNotificationsEnabled: params.emailNotificationsEnabled,
    emailNotificationsRealtime: false,
    emailNotificationsDailySummary: params.emailNotificationsDailySummary,
    emailNotificationsWeeklySummary:
      params.emailNotificationsWeeklySummary ?? false,
    emailNotificationsMonthlySummary: false,
    notificationDigestEnabled: true,
    notificationDigestFrequency: params.digestFrequency ?? 'daily',
    notificationDigestDeliveryChannel: params.deliveryChannel ?? 'both',
    notificationDigestLastSentAt: null,
    updatedAt: new Date(),
  });
  await db.insert(markets).values({
    id: params.id,
    question: 'Digest fixture market?',
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    updatedAt: new Date(),
  });
  await db.insert(positions).values({
    id: `${params.id}-position`,
    userId: params.id,
    marketId: params.id,
    side: true,
    outcome: true,
    status: 'resolved',
    shares: '10',
    avgPrice: '0.5',
    pnl: '25.50',
    resolvedAt: new Date(Date.now() - 3600000),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  // Exact state the unsubscribe route leaves behind: every flag off.
  await seedUser({
    id: unsubUserId,
    emailNotificationsEnabled: false,
    emailNotificationsDailySummary: false,
  });
  // Fully opted in to daily summary emails.
  await seedUser({
    id: optinUserId,
    emailNotificationsEnabled: true,
    emailNotificationsDailySummary: true,
  });
  // Master toggle on, but the daily summary category itself is off.
  await seedUser({
    id: catoffUserId,
    emailNotificationsEnabled: true,
    emailNotificationsDailySummary: false,
  });
  // Weekly digest by email only, weekly summary category off.
  await seedUser({
    id: weeklyOffUserId,
    emailNotificationsEnabled: true,
    emailNotificationsDailySummary: true,
    emailNotificationsWeeklySummary: false,
    digestFrequency: 'weekly',
    deliveryChannel: 'email',
  });
});

afterAll(async () => {
  for (const userId of allUserIds) {
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(positions).where(eq(positions.userId, userId));
    await db.delete(markets).where(eq(markets.id, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

async function deliverDailyDigest(userId: string) {
  const candidates = await listDigestCandidates();
  const candidate = candidates.find((entry) => entry.id === userId);
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error('candidate missing');
  return deliverDigestForUser({
    candidate,
    settings: {
      digestEnabled: true,
      frequency: 'daily',
      deliveryChannel: 'both',
    },
    now: new Date(),
  });
}

test('digest email is not sent to a user who unsubscribed from all notification emails', async () => {
  const result = await deliverDailyDigest(unsubUserId);
  expect(sentEmails.filter((mail) => mail.userId === unsubUserId)).toEqual([]);
  // The in-app digest is not an email: it must still be delivered.
  expect(result.delivered).toBe(true);
  const inApp = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, unsubUserId));
  expect(inApp).toHaveLength(1);
  expect(inApp[0]?.type).toBe('daily_summary');
});

test('digest email is not sent when the daily summary category is off', async () => {
  const result = await deliverDailyDigest(catoffUserId);
  expect(sentEmails.filter((mail) => mail.userId === catoffUserId)).toEqual([]);
  expect(result.delivered).toBe(true);
  const inApp = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, catoffUserId));
  expect(inApp).toHaveLength(1);
});

test('digest email is sent to a user who opted in to daily summary emails', async () => {
  const result = await deliverDailyDigest(optinUserId);
  expect(result.delivered).toBe(true);
  const mails = sentEmails.filter((mail) => mail.userId === optinUserId);
  expect(mails).toHaveLength(1);
  expect(mails[0]?.category).toBe('daily_summary');
});

test('weekly digest email is not sent when the weekly summary category is off', async () => {
  const candidates = await listDigestCandidates();
  const candidate = candidates.find((entry) => entry.id === weeklyOffUserId);
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error('candidate missing');
  const result = await deliverDigestForUser({
    candidate,
    settings: {
      digestEnabled: true,
      frequency: 'weekly',
      deliveryChannel: 'email',
    },
    now: new Date(),
  });
  expect(sentEmails.filter((mail) => mail.userId === weeklyOffUserId)).toEqual(
    []
  );
  // Email was the only channel and it is preference-blocked: nothing was
  // delivered, so the delivery checkpoint must not advance.
  expect(result.delivered).toBe(false);
  const [row] = await db
    .select({ lastSentAt: users.notificationDigestLastSentAt })
    .from(users)
    .where(eq(users.id, weeklyOffUserId));
  expect(row?.lastSentAt).toBeNull();
});
