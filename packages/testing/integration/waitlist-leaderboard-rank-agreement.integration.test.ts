/**
 * Waitlist leaderboard rank agreement (real database, real service).
 *
 * The waitlist leaderboard list (WaitlistService.getTopWaitlistUsers,
 * served by GET /api/waitlist/leaderboard) ranks the default invite board
 * by invitePoints desc, then reputationPoints desc, then waitlistJoinedAt
 * asc. The "my position" surface (WaitlistService.getWaitlistPosition,
 * served by GET /api/waitlist/position) promises its leaderboardRank is
 * "What users see!" — the same rank the list shows.
 *
 * On base the position counter drops the reputationPoints tiebreak: it
 * counts users ahead by invite points and join time only, so an
 * invite-tied user with more reputation points but a later join time is
 * rank 1 on the list and rank 2 in their own position (and the earlier
 * joiner shows the reverse). A pair tied on invite, reputation, and join
 * time also gets sequential list ranks but one shared position rank,
 * because neither ordering has a final deterministic key.
 *
 * Both surfaces must share one total order: invite desc, reputation desc,
 * joinedAt asc, id asc.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { WaitlistService } from '@feed/api';
import { db, inArray, users } from '@feed/db';

const T = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (ms: number) => new Date(T + ms);

const REP_WINNER = 'f104-a-repwinner';
const EARLY = 'f104-b-early';
const SAME_REP_LATER = 'f104-d-samerep';
const LOW_INVITE = 'f104-c-lowinvite';
const TIE_A = 'f104-tie-a';
const TIE_B = 'f104-tie-b';

const ALL_IDS = [REP_WINNER, EARLY, SAME_REP_LATER, LOW_INVITE, TIE_A, TIE_B];

function fixture(
  id: string,
  invitePoints: number,
  reputationPoints: number,
  joinedAt: Date,
  waitlistPosition: number
) {
  return {
    id,
    username: id,
    displayName: id,
    invitePoints,
    reputationPoints,
    isWaitlistActive: true,
    waitlistPosition,
    waitlistJoinedAt: joinedAt,
    updatedAt: joinedAt,
  };
}

beforeAll(async () => {
  await db.insert(users).values([
    // Invite tie, most reputation, joined after EARLY: list rank 1.
    fixture(REP_WINNER, 100, 900, at(10_000), 1),
    // Invite tie, less reputation, joined first: list rank 2.
    fixture(EARLY, 100, 100, at(0), 2),
    // Invite and reputation tie with EARLY, joined later: list rank 3.
    fixture(SAME_REP_LATER, 100, 100, at(20_000), 3),
    // Most reputation overall but fewer invites: invite board rank 4.
    fixture(LOW_INVITE, 50, 5000, at(0), 4),
    // Exact triple tie (invite, reputation, joinedAt): id order decides.
    fixture(TIE_A, 10, 10, at(30_000), 5),
    fixture(TIE_B, 10, 10, at(30_000), 6),
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ALL_IDS));
});

describe('waitlist leaderboard list and position agree', () => {
  it('list ranks follow invite, reputation, joinedAt, id', async () => {
    const board = await WaitlistService.getTopWaitlistUsers(100, 0, 'invite');
    const mine = board.filter((entry) => ALL_IDS.includes(entry.id));
    expect(mine.map((entry) => entry.id)).toEqual([
      REP_WINNER,
      EARLY,
      SAME_REP_LATER,
      LOW_INVITE,
      TIE_A,
      TIE_B,
    ]);
    expect(mine.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('position rank matches the list rank for invite ties', async () => {
    const board = await WaitlistService.getTopWaitlistUsers(100, 0, 'invite');
    const listRank = new Map(board.map((entry) => [entry.id, entry.rank]));

    for (const id of [REP_WINNER, EARLY, SAME_REP_LATER, LOW_INVITE]) {
      const position = await WaitlistService.getWaitlistPosition(id);
      expect(position?.leaderboardRank).toBe(listRank.get(id));
    }
  });

  it('position rank matches the list rank for an exact triple tie', async () => {
    const board = await WaitlistService.getTopWaitlistUsers(100, 0, 'invite');
    const listRank = new Map(board.map((entry) => [entry.id, entry.rank]));

    for (const id of [TIE_A, TIE_B]) {
      const position = await WaitlistService.getWaitlistPosition(id);
      expect(position?.leaderboardRank).toBe(listRank.get(id));
    }
  });

  it('total-points tab still ranks by reputation first', async () => {
    const board = await WaitlistService.getTopWaitlistUsers(100, 0, 'total');
    const mine = board.filter((entry) => ALL_IDS.includes(entry.id));
    expect(mine[0]?.id).toBe(LOW_INVITE);
    expect(mine[0]?.points).toBe(5000);
  });
});
