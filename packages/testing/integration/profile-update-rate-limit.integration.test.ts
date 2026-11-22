/**
 * PRD §8.1: per-account rate limits apply across all clients and the web.
 * The profile update route must refuse an update once the account has used
 * its profile update or username change allowance.
 */
import { beforeAll, expect, mock, test } from 'bun:test';
import { dbWrite, eq, profileUpdateLogs, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

// Only the server-only environment marker is stubbed; the route runs as is.
mock.module('server-only', () => ({}));

let updateProfileRoute: typeof import('../../../apps/web/src/app/api/users/[userId]/update-profile/route').POST;
beforeAll(async () => {
  ({ POST: updateProfileRoute } = await import(
    '../../../apps/web/src/app/api/users/[userId]/update-profile/route'
  ));
});

const ip = crypto.getRandomValues(new Uint8Array(2));
const clientIp = `198.19.${ip[0]}.${ip[1]}`;

async function updateProfile(userId: string, body: Record<string, string>) {
  const previous = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
  try {
    return await updateProfileRoute(
      new NextRequest(`http://localhost/api/users/${userId}/update-profile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          authorization: `Bearer steward:test:${userId}`,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ userId }) }
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previous;
  }
}

async function withUser(
  priorChanges: string[][],
  run: (userId: string, username: string) => Promise<void>
) {
  const userId = crypto.randomUUID();
  const username = `rl${crypto.randomUUID().slice(0, 8)}`;
  await dbWrite.insert(users).values({
    id: userId,
    username,
    displayName: 'Before',
    updatedAt: new Date(),
  });
  for (const changedFields of priorChanges) {
    await dbWrite.insert(profileUpdateLogs).values({
      id: await generateSnowflakeId(),
      userId,
      changedFields,
      backendSigned: false,
      createdAt: new Date(),
    });
  }
  try {
    await run(userId, username);
  } finally {
    await dbWrite
      .delete(profileUpdateLogs)
      .where(eq(profileUpdateLogs.userId, userId));
    await dbWrite.delete(users).where(eq(users.id, userId));
  }
}

async function readUser(userId: string) {
  const [user] = await dbWrite
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  return user;
}

test('a third username change in a day is refused and not saved', async () => {
  await withUser([['username'], ['username']], async (userId, username) => {
    const response = await updateProfile(userId, {
      username: `x${username}`,
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'You can only change your username twice per day.',
    });
    expect((await readUser(userId))?.username).toBe(username);
  });
});

test('an eleventh profile update in an hour is refused and not saved', async () => {
  const tenUpdates = Array.from({ length: 10 }, () => ['displayName']);
  await withUser(tenUpdates, async (userId) => {
    const response = await updateProfile(userId, { displayName: 'After' });
    expect(response.status).toBe(429);
    expect((await readUser(userId))?.displayName).toBe('Before');
  });
});

test('an update within the allowance still succeeds', async () => {
  await withUser([['username']], async (userId, username) => {
    const response = await updateProfile(userId, {
      username: `y${username}`,
      displayName: 'After',
    });
    expect(response.status).toBe(200);
    expect(await readUser(userId)).toEqual({
      username: `y${username}`,
      displayName: 'After',
    });
  });
});
