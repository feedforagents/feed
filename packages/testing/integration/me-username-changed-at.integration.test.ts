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
 *
 * Fixture ownership: each fixture row is inserted on its own with
 * `.returning()`, and only IDs the database confirms as inserted are
 * recorded as owned. Cleanup deletes exactly those IDs, so a failed or
 * colliding setup can never delete a user this suite never created.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, inArray, users } from '@feed/db';
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

// IDs the database confirmed as inserted by this suite. Cleanup deletes
// only these — never an ID that was merely generated before an INSERT.
const ownedUserIds: string[] = [];

async function insertFixture(
  values: typeof users.$inferInsert
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  if (!row) throw new Error('Fixture insert returned no row');
  ownedUserIds.push(row.id);
  return row.id;
}

async function cleanupOwnedUsers(): Promise<void> {
  if (ownedUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, ownedUserIds));
}

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
  // One INSERT per fixture with RETURNING: if the second insert collides,
  // only the first ID is owned (and cleaned); the failed ID never is.
  await insertFixture({
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
  });
  await insertFixture({
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
  });
});

afterAll(async () => {
  await cleanupOwnedUsers();
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

  // Runs last: it exercises the suite cleanup, which removes the two
  // fixtures, so no later test may depend on them.
  it('a failed colliding setup leaves an unrelated user untouched', async () => {
    // Stand-in for a pre-existing user this suite never owned.
    const bystanderId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(users).values({
      id: bystanderId,
      username: `f59b-${bystanderId}`,
      displayName: 'Bystander Fixture',
      bio: 'Fixture bio',
      profileImageUrl: 'https://example.com/avatar.png',
      profileComplete: true,
      hasUsername: true,
      hasBio: true,
      hasProfileImage: true,
      usernameChangedAt: null,
      updatedAt: now,
    });

    try {
      // Bulk setup colliding on the bystander's id: the whole INSERT
      // fails, so neither row is created and neither id becomes owned.
      // (try/catch rather than expect().rejects: a Drizzle query builder
      // is a thenable, not a Promise, and bun's .rejects rejects it.)
      const collidingId = await generateSnowflakeId();
      let insertThrew = false;
      try {
        await db.insert(users).values([
          {
            id: bystanderId,
            username: `f59x-${bystanderId}`,
            displayName: 'Colliding Fixture',
            bio: 'Fixture bio',
            profileImageUrl: 'https://example.com/avatar.png',
            profileComplete: true,
            hasUsername: true,
            hasBio: true,
            hasProfileImage: true,
            usernameChangedAt: null,
            updatedAt: now,
          },
          {
            id: collidingId,
            username: `f59x-${collidingId}`,
            displayName: 'Colliding Fixture',
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
      } catch {
        insertThrew = true;
      }
      expect(insertThrew).toBe(true);

      // Run the exact cleanup afterAll uses: it must not touch the
      // bystander, and the failed colliding id must not exist either.
      await cleanupOwnedUsers();
      const [bystander] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, bystanderId))
        .limit(1);
      expect(bystander?.id).toBe(bystanderId);
      const [colliding] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, collidingId))
        .limit(1);
      expect(colliding).toBeUndefined();
    } finally {
      // The bystander is this test's own stand-in: remove it explicitly,
      // never through the suite's owned-ids cleanup.
      await db.delete(users).where(eq(users.id, bystanderId));
    }
  });
});
