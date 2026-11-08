/**
 * GET /api/leaderboard after a profile rename, against a real database.
 *
 * Leaderboard pages are cached whole (shared pages, 120s default TTL) with
 * each row's displayName/profileImageUrl baked into the cached payload,
 * while the same route computes the requesting user's own position fresh
 * on every request ("user positions are always computed fresh"). A profile
 * update invalidates the user and identifier caches, so every other
 * identity surface reflects a rename immediately — but nothing invalidated
 * the leaderboard page cache, so right after a rename one leaderboard
 * response showed the user under their old name/avatar in the page rows
 * and their new name/avatar in currentUser.
 *
 * The update goes through the real update-profile route and the reads
 * through the real leaderboard and profile routes; no module is mocked
 * beyond the `server-only` import guard.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const OLD = {
  username: 'renameprobeold',
  displayName: 'Rename Probe Old',
  profileImageUrl: 'https://img.example/rename-old.png',
};
const NEW = {
  displayName: 'Rename Probe New',
  bio: 'rename probe new bio',
  profileImageUrl: 'https://img.example/rename-new.png',
};
const OTHER = {
  username: 'renameprobeother',
  displayName: 'Rename Probe Other',
  profileImageUrl: 'https://img.example/rename-other.png',
};

let U = '';
let W = '';
let updateProfilePOST: Function;
let profileGET: Function;
let leaderboardGET: Function;

function req(url: string, asUser?: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (asUser) headers.set('x-dev-user-id', asUser);
  return new NextRequest(new Request(url, { ...init, headers }));
}

type LeaderboardBody = {
  leaderboard: Array<Record<string, unknown>>;
  currentUser: { entry: Record<string, unknown> } | null;
};

async function readLeaderboard(): Promise<LeaderboardBody> {
  const res = await leaderboardGET(
    req(
      `http://localhost/api/leaderboard?metric=reputation&type=wallet&page=1&pageSize=100&userId=${U}`
    )
  );
  return (await res.json()) as LeaderboardBody;
}

beforeAll(async () => {
  const base = '../../../apps/web/src/app/api';
  ({ POST: updateProfilePOST } = await import(
    `${base}/users/[userId]/update-profile/route`
  ));
  ({ GET: profileGET } = await import(`${base}/users/[userId]/profile/route`));
  ({ GET: leaderboardGET } = await import(`${base}/leaderboard/route`));

  [U, W] = await Promise.all([generateSnowflakeId(), generateSnowflakeId()]);
  const now = new Date();
  await db.insert(users).values([
    {
      id: U,
      username: OLD.username,
      displayName: OLD.displayName,
      profileImageUrl: OLD.profileImageUrl,
      reputationPoints: 888888,
      updatedAt: now,
    },
    {
      id: W,
      username: OTHER.username,
      displayName: OTHER.displayName,
      profileImageUrl: OTHER.profileImageUrl,
      reputationPoints: 777777,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [U, W]));
});

describe('leaderboard identity after a profile rename', () => {
  it('shows the new name/avatar in the page rows, matching currentUser', async () => {
    // Warm the shared page cache with the pre-rename identity.
    const before = await readLeaderboard();
    const beforeRow = before.leaderboard.find((e) => e.id === U);
    expect(beforeRow?.displayName).toBe(OLD.displayName);
    expect(before.currentUser?.entry.displayName).toBe(OLD.displayName);

    const updateRes = await updateProfilePOST(
      req(`http://localhost/api/users/${U}/update-profile`, U, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...NEW }),
      }),
      { params: Promise.resolve({ userId: U }) }
    );
    expect(updateRes.status).toBe(200);

    // Guard: the profile header already reflects the rename (it goes
    // through the identifier/user caches the update invalidates).
    const profileRes = await profileGET(
      req(`http://localhost/api/users/${U}/profile`),
      { params: Promise.resolve({ userId: U }) }
    );
    const profileBody = (await profileRes.json()) as {
      user: Record<string, unknown> | null;
    };
    expect(profileBody.user?.displayName).toBe(NEW.displayName);
    expect(profileBody.user?.profileImageUrl).toBe(NEW.profileImageUrl);

    const after = await readLeaderboard();
    const afterRow = after.leaderboard.find((e) => e.id === U);
    const otherRow = after.leaderboard.find((e) => e.id === W);

    // The requester's fresh position carries the new identity...
    expect(after.currentUser?.entry.displayName).toBe(NEW.displayName);
    expect(after.currentUser?.entry.profileImageUrl).toBe(NEW.profileImageUrl);
    // ...and the page rows in the same response must agree with it.
    expect(afterRow?.displayName).toBe(NEW.displayName);
    expect(afterRow?.profileImageUrl).toBe(NEW.profileImageUrl);
    // Another user's row is unaffected by the rename.
    expect(otherRow?.displayName).toBe(OTHER.displayName);
    expect(otherRow?.profileImageUrl).toBe(OTHER.profileImageUrl);
  });
});
