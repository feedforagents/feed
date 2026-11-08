/**
 * GET /api/waitlist/position against a real database: the referral counts
 * in the waitlist position response must count the user's full referral
 * sets, not the capped list windows returned alongside them.
 *
 * The route caps the invited/qualified user LISTS at 25 rows ("Limit
 * referral lists to prevent unbounded payloads"), which is a payload
 * choice. But it also derives invitedCount, qualifiedCount and
 * weeklyReferralCount from those capped windows, so a user with more
 * than 25 referrals in either bucket is told a smaller number than the
 * truth — the counts contradict the response's own referralCount (the
 * WaitlistService total) and the sibling web referrals route, which
 * computes its weekly count with a dedicated COUNT query over the full
 * set. Nothing else in the response (no total, no hasMore) lets the
 * user recover the real counts.
 *
 * Fixtures reproduce the exact row shapes the real writers produce:
 * completed referrals are Referral rows with status 'completed' plus a
 * referred user with profileComplete=true and referredBy set (signup and
 * WaitlistService.markAsWaitlisted); pending referrals are referred
 * users with profileComplete=false and no Referral row yet (the
 * /api/users/me stub created when a visitor arrives via a referral
 * link); a completed row with referredUserId=null is the state
 * delete-account leaves behind for a deleted referee.
 *
 * The only stub is the `server-only` marker package; auth uses the
 * dev-user header the API middleware supports in this environment, and
 * every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, referrals, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type PositionBody = {
  position: number | null;
  referralCount?: number;
  weeklyReferralCount?: number;
  invitedUsers?: Array<{ id: string }>;
  qualifiedUsers?: Array<{ id: string }>;
  invitedCount?: number;
  qualifiedCount?: number;
};

let GET_POSITION: typeof import('../../../apps/web/src/app/api/waitlist/position/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const allUserIds: string[] = [];
const allReferralIds: string[] = [];

const HOUR = 3_600_000;
const now = Date.now();

async function makeUser(
  label: string,
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  allUserIds.push(id);
  await db.insert(users).values({
    id,
    username: `f33wl-${label}-${suffix}-${id.slice(-6)}`,
    displayName: `F33 WL ${label}`,
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
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

async function usernameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ username: users.username })
    .from(users)
    .where(inArray(users.id, [userId]));
  return row!.username!;
}

async function fetchPosition(userId: string): Promise<PositionBody> {
  const request = new NextRequest('http://localhost/api/waitlist/position', {
    headers: { 'x-dev-user-id': userId },
  });
  const response = await GET_POSITION(request);
  expect(response.status).toBe(200);
  return (await response.json()) as PositionBody;
}

// Referrer A: 27 recent completed + 3 older completed + 1 orphan completed
// (all with distinct completion times), 27 pending.
let referrerA: string;
// Referrer B: small numbers — 3 completed (all this week), 2 pending.
let referrerB: string;

beforeAll(async () => {
  ({ GET: GET_POSITION } = await import(
    '../../../apps/web/src/app/api/waitlist/position/route'
  ));

  referrerA = await makeUser('referrer-a', {
    isWaitlistActive: true,
    waitlistPosition: 1,
    waitlistJoinedAt: new Date(now - 60 * 24 * HOUR),
    referralCount: 31,
  });
  const codeA = await usernameOf(referrerA);
  for (let i = 0; i < 27; i++) {
    const uid = await makeUser(`a-comp-${i}`, {
      referredBy: referrerA,
      profileComplete: true,
      createdAt: new Date(now - (50 - i) * HOUR),
    });
    await makeCompletedReferral(
      referrerA,
      codeA,
      uid,
      new Date(now - (48 - i) * HOUR)
    );
  }
  for (let i = 0; i < 3; i++) {
    const uid = await makeUser(`a-old-${i}`, {
      referredBy: referrerA,
      profileComplete: true,
      createdAt: new Date(now - (35 + i) * 24 * HOUR),
    });
    await makeCompletedReferral(
      referrerA,
      codeA,
      uid,
      new Date(now - (30 + i) * 24 * HOUR)
    );
  }
  // Deleted referee: delete-account nulls referredUserId on the row.
  await makeCompletedReferral(referrerA, codeA, null, new Date(now - 5 * HOUR));
  for (let i = 0; i < 27; i++) {
    await makeUser(`a-pend-${i}`, {
      referredBy: referrerA,
      profileComplete: false,
      createdAt: new Date(now - (40 - i) * HOUR),
    });
  }

  referrerB = await makeUser('referrer-b', {
    isWaitlistActive: true,
    waitlistPosition: 2,
    waitlistJoinedAt: new Date(now - 60 * 24 * HOUR),
    referralCount: 3,
  });
  const codeB = await usernameOf(referrerB);
  for (let i = 0; i < 3; i++) {
    const uid = await makeUser(`b-comp-${i}`, {
      referredBy: referrerB,
      profileComplete: true,
      createdAt: new Date(now - (10 - i) * HOUR),
    });
    await makeCompletedReferral(
      referrerB,
      codeB,
      uid,
      new Date(now - (9 - i) * HOUR)
    );
  }
  for (let i = 0; i < 2; i++) {
    await makeUser(`b-pend-${i}`, {
      referredBy: referrerB,
      profileComplete: false,
      createdAt: new Date(now - (8 - i) * HOUR),
    });
  }
});

afterAll(async () => {
  await db.delete(referrals).where(inArray(referrals.id, allReferralIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('waitlist position referral counts', () => {
  it('counts every qualified referral, not just the capped list window', async () => {
    const body = await fetchPosition(referrerA);
    // 27 recent + 3 older completed referrals with a live user row.
    expect(body.qualifiedCount).toBe(30);
    // The list itself stays capped at 25 rows.
    expect(body.qualifiedUsers!.length).toBeLessThanOrEqual(25);
  });

  it('counts every invited (pending) referral, not just the capped window', async () => {
    const body = await fetchPosition(referrerA);
    expect(body.invitedCount).toBe(27);
    expect(body.invitedUsers!.length).toBeLessThanOrEqual(25);
  });

  it('counts this week’s completed referrals over the full set', async () => {
    const body = await fetchPosition(referrerA);
    // 27 recent completed rows + the orphan row completed 5 hours ago;
    // the 3 older rows fall outside the 7-day window.
    expect(body.weeklyReferralCount).toBe(28);
  });

  it('still reports exact counts when the sets fit inside the window', async () => {
    const body = await fetchPosition(referrerB);
    expect(body.qualifiedCount).toBe(3);
    expect(body.invitedCount).toBe(2);
    expect(body.weeklyReferralCount).toBe(3);
    expect(body.qualifiedUsers).toHaveLength(3);
    expect(body.invitedUsers).toHaveLength(2);
  });
});
