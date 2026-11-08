/**
 * GET /api/users/[userId]/referrals against a real database: every count
 * in the response must describe the same population the response lists.
 *
 * A completed Referral row can outlive its referred user: the
 * delete-account route nulls `referredUserId` on the row instead of
 * deleting it (`apps/web/src/app/api/users/delete-account/route.ts`:
 * "Delete referral relationships - set referredUserId to null"), and the
 * user row itself is then removed. The referrals route drops such orphan
 * rows from `referredUsers` (their user lookup misses) but, on base,
 * still counts them in `stats.totalReferrals` (the raw completed-row
 * array length) and in `stats.weeklyReferralCount` (a COUNT over all
 * completed Referral rows) — so a referrer whose referee deleted their
 * account is told a larger total and weekly count than the list can
 * ever show (F33 probe on this route: totalReferrals 33 vs 32 listed).
 *
 * Fixtures reproduce the exact row shapes the real writers produce:
 * completed referrals are Referral rows with status 'completed' plus a
 * referred user with profileComplete=true and referredBy set; pending
 * referrals are referred users with profileComplete=false; an orphan is
 * produced by creating the referee and the completed row, then applying
 * the delete-account route's own nulling update and removing the user
 * row.
 *
 * The only stub is the `server-only` marker package; auth uses the
 * dev-user header the API middleware supports in this environment, and
 * every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, inArray, referrals, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ReferralsBody = {
  stats: {
    totalReferrals: number;
    pendingReferrals: number;
    weeklyReferralCount: number;
  };
  referredUsers: Array<{ id: string; joinedAt: string | null }>;
  pendingReferredUsers: Array<{ id: string }>;
};

let GET_REFERRALS: typeof import('../../../apps/web/src/app/api/users/[userId]/referrals/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const allUserIds: string[] = [];
const allReferralIds: string[] = [];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

async function makeUser(
  label: string,
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  allUserIds.push(id);
  await db.insert(users).values({
    id,
    username: `f35ref-${label}-${suffix}-${id.slice(-6)}`,
    displayName: `F35 Ref ${label}`,
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

async function usernameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId));
  return row!.username!;
}

async function makeCompletedReferral(
  referrerId: string,
  code: string,
  referredUserId: string | null,
  completedAt: Date
): Promise<void> {
  const id = await generateSnowflakeId();
  allReferralIds.push(id);
  await db.insert(referrals).values({
    id,
    referrerId,
    referralCode: code,
    referredUserId,
    status: 'completed',
    completedAt,
    createdAt: completedAt,
  });
}

/**
 * A completed referral whose referee then deletes their account: the
 * delete-account route nulls referredUserId and removes the user row,
 * leaving the completed row behind as an orphan.
 */
async function makeOrphanedCompletedReferral(
  referrerId: string,
  code: string,
  label: string,
  completedAt: Date
): Promise<void> {
  const refereeId = await makeUser(label, {
    referredBy: referrerId,
    profileComplete: true,
    createdAt: completedAt,
  });
  await makeCompletedReferral(referrerId, code, refereeId, completedAt);
  await db
    .update(referrals)
    .set({ referredUserId: null })
    .where(eq(referrals.referredUserId, refereeId));
  await db.delete(users).where(eq(users.id, refereeId));
}

async function fetchReferrals(userId: string): Promise<ReferralsBody> {
  const request = new NextRequest(
    `http://localhost/api/users/${userId}/referrals?includeStats=true`,
    { headers: { 'x-dev-user-id': userId } }
  );
  const response = await GET_REFERRALS(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ReferralsBody;
}

// Referrer A: 4 recent visible completed + 2 older visible completed,
// 1 recent orphan + 1 older orphan, 3 pending.
let referrerA: string;
// Referrer B: small numbers, no orphans — 2 recent completed, 1 pending.
let referrerB: string;
// Referrer C: 30 visible completed, all recent — reachability guard.
let referrerC: string;

beforeAll(async () => {
  ({ GET: GET_REFERRALS } = await import(
    '../../../apps/web/src/app/api/users/[userId]/referrals/route'
  ));

  referrerA = await makeUser('referrer-a');
  const codeA = await usernameOf(referrerA);
  for (let i = 0; i < 4; i++) {
    const uid = await makeUser(`a-recent-${i}`, {
      referredBy: referrerA,
      profileComplete: true,
      createdAt: new Date(now - (12 + i) * HOUR),
    });
    await makeCompletedReferral(
      referrerA,
      codeA,
      uid,
      new Date(now - (10 + i) * HOUR)
    );
  }
  for (let i = 0; i < 2; i++) {
    const uid = await makeUser(`a-old-${i}`, {
      referredBy: referrerA,
      profileComplete: true,
      createdAt: new Date(now - (31 + i) * DAY),
    });
    await makeCompletedReferral(
      referrerA,
      codeA,
      uid,
      new Date(now - (30 + i) * DAY)
    );
  }
  await makeOrphanedCompletedReferral(
    referrerA,
    codeA,
    'a-gone-recent',
    new Date(now - 5 * HOUR)
  );
  await makeOrphanedCompletedReferral(
    referrerA,
    codeA,
    'a-gone-old',
    new Date(now - 30 * DAY)
  );
  for (let i = 0; i < 3; i++) {
    await makeUser(`a-pend-${i}`, {
      referredBy: referrerA,
      profileComplete: false,
      createdAt: new Date(now - (20 - i) * HOUR),
    });
  }

  referrerB = await makeUser('referrer-b');
  const codeB = await usernameOf(referrerB);
  for (let i = 0; i < 2; i++) {
    const uid = await makeUser(`b-comp-${i}`, {
      referredBy: referrerB,
      profileComplete: true,
      createdAt: new Date(now - (8 - i) * HOUR),
    });
    await makeCompletedReferral(
      referrerB,
      codeB,
      uid,
      new Date(now - (7 - i) * HOUR)
    );
  }
  await makeUser('b-pend-0', {
    referredBy: referrerB,
    profileComplete: false,
    createdAt: new Date(now - 6 * HOUR),
  });

  referrerC = await makeUser('referrer-c');
  const codeC = await usernameOf(referrerC);
  for (let i = 0; i < 30; i++) {
    const uid = await makeUser(`c-comp-${i}`, {
      referredBy: referrerC,
      profileComplete: true,
      createdAt: new Date(now - (50 - i) * HOUR),
    });
    await makeCompletedReferral(
      referrerC,
      codeC,
      uid,
      new Date(now - (49 - i) * HOUR)
    );
  }
});

afterAll(async () => {
  await db.delete(referrals).where(inArray(referrals.id, allReferralIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('user referrals count consistency', () => {
  it('counts only completed referrals that appear in the referredUsers list', async () => {
    const body = await fetchReferrals(referrerA);
    // 4 recent + 2 older visible referees; the 2 orphan rows are not listed.
    expect(body.referredUsers).toHaveLength(6);
    expect(body.stats.totalReferrals).toBe(6);
    expect(body.stats.totalReferrals).toBe(body.referredUsers.length);
  });

  it('counts this week’s referrals over the same listed population', async () => {
    const body = await fetchReferrals(referrerA);
    // 4 visible completions inside 7 days; the recent orphan (5h ago)
    // is not in the list and must not inflate the weekly count.
    expect(body.stats.weeklyReferralCount).toBe(4);
  });

  it('keeps the pending count equal to the pending list', async () => {
    const body = await fetchReferrals(referrerA);
    expect(body.pendingReferredUsers).toHaveLength(3);
    expect(body.stats.pendingReferrals).toBe(3);
  });

  it('still reports exact counts when there are no orphans', async () => {
    const body = await fetchReferrals(referrerB);
    expect(body.referredUsers).toHaveLength(2);
    expect(body.stats.totalReferrals).toBe(2);
    expect(body.stats.weeklyReferralCount).toBe(2);
    expect(body.pendingReferredUsers).toHaveLength(1);
    expect(body.stats.pendingReferrals).toBe(1);
  });

  it('returns the full completed list with no truncation', async () => {
    const body = await fetchReferrals(referrerC);
    expect(body.referredUsers).toHaveLength(30);
    expect(body.stats.totalReferrals).toBe(30);
    expect(body.stats.weeklyReferralCount).toBe(30);
  });
});
