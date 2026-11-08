/**
 * GET /api/users/me against a real database: the response must carry the
 * user's `usernameChangedAt` record.
 *
 * The settings page computes its username cooldown from this exact field:
 * `getUsernameChangeTimeRemaining` in apps/web/src/app/settings/page.tsx
 * disables the username input and renders "Username can only be changed
 * once every 24 hours. Please wait Xh Ym before changing again." from
 * `user.usernameChangedAt`, and the auth-store `User` type declares the
 * field. The store is populated from GET /api/users/me (useAuth), and both
 * sibling responses that expose the same record — the update-profile POST
 * response and the public profile route — include `usernameChangedAt`.
 * Only /api/users/me dropped it, so after any fresh page load the settings
 * page saw `usernameChangedAt === undefined`, treated the user as free to
 * change their username, and never showed the remaining wait even when the
 * recorded last change was minutes ago.
 *
 * The request is authenticated with the existing CI synthetic bearer. The
 * only stub is the `server-only` marker package (an empty environment
 * guard that throws outside a Server Component); every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type MeResponse = {
  authenticated: boolean;
  needsOnboarding: boolean;
  user: {
    id: string;
    username: string | null;
    usernameChangedAt?: string | null;
  } | null;
};

let changedUserId: string;
let neverChangedUserId: string;
const changedAt = new Date(Date.now() - 2 * 60 * 60_000);

let GET: typeof import('../../../apps/web/src/app/api/users/me/route').GET;

async function fetchMe(userId: string) {
  const request = new NextRequest(
    new Request('http://localhost/api/users/me'),
    { headers: { authorization: `Bearer steward:test:${userId}` } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as MeResponse | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/users/me/route'));

  [changedUserId, neverChangedUserId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  await db.insert(users).values([
    {
      id: changedUserId,
      username: `f59c-${changedUserId}`,
      displayName: 'Changed Username Fixture',
      bio: 'Fixture bio',
      profileImageUrl: 'https://example.com/avatar.png',
      profileComplete: true,
      hasUsername: true,
      hasBio: true,
      hasProfileImage: true,
      usernameChangedAt: changedAt,
      updatedAt: now,
    },
    {
      id: neverChangedUserId,
      username: `f59n-${neverChangedUserId}`,
      displayName: 'Never Changed Fixture',
      bio: 'Fixture bio',
      profileImageUrl: 'https://example.com/avatar.png',
      profileComplete: true,
      hasUsername: true,
      hasBio: true,
      hasProfileImage: true,
      usernameChangedAt: null,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(users)
    .where(inArray(users.id, [changedUserId, neverChangedUserId]));
});

describe('GET /api/users/me usernameChangedAt', () => {
  it('returns the recorded last username change time', async () => {
    const { status, body } = await fetchMe(changedUserId);

    expect(status).toBe(200);
    expect(body?.user?.id).toBe(changedUserId);
    expect(body?.user?.usernameChangedAt).toBe(changedAt.toISOString());
  });

  it('returns null for a user who never changed their username', async () => {
    const { status, body } = await fetchMe(neverChangedUserId);

    expect(status).toBe(200);
    expect(body?.user?.id).toBe(neverChangedUserId);
    expect(body?.user?.usernameChangedAt).toBeNull();
  });

  it('keeps the rest of the profile payload intact', async () => {
    const { status, body } = await fetchMe(changedUserId);

    expect(status).toBe(200);
    expect(body?.authenticated).toBe(true);
    expect(body?.needsOnboarding).toBe(false);
    expect(body?.user?.username).toBe(`f59c-${changedUserId}`);
  });
});
