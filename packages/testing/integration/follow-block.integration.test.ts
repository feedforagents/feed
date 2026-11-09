import { afterAll, describe, expect, it } from 'bun:test';
import {
  and,
  db,
  dbWrite,
  eq,
  follows,
  inArray,
  notifications,
  or,
  sql,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';

/**
 * The supported isolated integration-test DID: with
 * ALLOW_TEST_PRIVY_DID_AUTH the server authenticates
 * `Bearer steward:test:<userId>` directly as that user, with no JWT and
 * no Steward round-trip.
 */
function testAuthHeader(userId: string) {
  return `Bearer steward:test:${userId}`;
}

const ownedUsers: string[] = [];

async function fixtureUser(): Promise<string> {
  const userId = await generateSnowflakeId();
  ownedUsers.push(userId);
  await db.insert(users).values({
    id: userId,
    username: `fb-${userId}`,
    updatedAt: new Date(),
  });
  return userId;
}

async function postFollow(followerId: string, targetId: string) {
  return fetch(`${baseUrl}/api/users/${targetId}/follow`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: testAuthHeader(followerId),
    },
    signal: AbortSignal.timeout(30000),
  });
}

async function postBlock(blockerId: string, targetId: string) {
  return fetch(`${baseUrl}/api/users/${targetId}/block`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: testAuthHeader(blockerId),
    },
    body: JSON.stringify({ action: 'block' }),
    signal: AbortSignal.timeout(30000),
  });
}

async function followRow(followerId: string, followingId: string) {
  const rows = await db
    .select({ id: follows.id })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerId),
        eq(follows.followingId, followingId)
      )
    );
  return rows[0] ?? null;
}

async function blockRow(blockerId: string, blockedId: string) {
  const rows = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId)
      )
    );
  return rows[0] ?? null;
}

afterAll(async () => {
  if (ownedUsers.length === 0) return;
  await db
    .delete(notifications)
    .where(inArray(notifications.userId, ownedUsers));
  await db
    .delete(follows)
    .where(
      or(
        inArray(follows.followerId, ownedUsers),
        inArray(follows.followingId, ownedUsers)
      )
    );
  await db
    .delete(userBlocks)
    .where(
      or(
        inArray(userBlocks.blockerId, ownedUsers),
        inArray(userBlocks.blockedId, ownedUsers)
      )
    );
  await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('POST /api/users/[userId]/follow block enforcement', () => {
  it('rejects a follow from a user the target has blocked', async () => {
    const userAId = await fixtureUser();
    const userBId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userAId,
      blockedId: userBId,
    });

    const response = await postFollow(userBId, userAId);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Cannot follow this user');
    expect(await followRow(userBId, userAId)).toBeNull();
  });

  it('rejects a follow toward a user the follower has blocked', async () => {
    const userAId = await fixtureUser();
    const userBId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userAId,
      blockedId: userBId,
    });

    const response = await postFollow(userAId, userBId);
    expect(response.status).toBe(400);
    expect(await followRow(userAId, userBId)).toBeNull();
  });

  it('rejects a follow when the block is in the other pair direction', async () => {
    const userDId = await fixtureUser();
    const userEId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userDId,
      blockedId: userEId,
    });

    const response = await postFollow(userEId, userDId);
    expect(response.status).toBe(400);
    expect(await followRow(userEId, userDId)).toBeNull();
  });

  it('still allows a follow with no block relationship', async () => {
    const userAId = await fixtureUser();
    const userCId = await fixtureUser();

    const response = await postFollow(userCId, userAId);
    expect(response.status).toBe(201);
    expect(await followRow(userCId, userAId)).not.toBeNull();
  });

  for (const first of ['follow', 'block'] as const) {
    for (const reverse of [false, true]) {
      it(`${first} first leaves no blocked follow (${reverse ? 'reverse' : 'forward'})`, async () => {
        const blocker = await fixtureUser();
        const blocked = await fixtureUser();
        const from = reverse ? blocked : blocker;
        const to = reverse ? blocker : blocked;
        const barrierId = await generateSnowflakeId();
        const ready = Promise.withResolvers<number>();
        const release = Promise.withResolvers<void>();
        const rollback = new Error('Owned follow/block barrier rollback');
        const requests: Promise<Response>[] = [];
        const barrierDone = dbWrite
          .transaction(async (tx) => {
            const rows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
            if (first === 'follow') {
              await tx
                .insert(follows)
                .values({ id: barrierId, followerId: from, followingId: to });
            } else {
              await tx.insert(userBlocks).values({
                id: barrierId,
                blockerId: blocker,
                blockedId: blocked,
              });
            }
            ready.resolve(Number(rows[0]?.pid));
            await release.promise;
          })
          .catch((error: Error) => {
            ready.reject(error);
            if (error !== rollback) throw error;
          });
        try {
          const barrierPid = await ready.promise;
          expect(Number.isInteger(barrierPid)).toBe(true);
          requests.push(
            first === 'follow'
              ? postFollow(from, to)
              : postBlock(blocker, blocked)
          );
          // Observe the actual request waiting on this run's exact barrier PID.
          const table = first === 'follow' ? 'Follow' : 'UserBlock';
          let firstPid = 0;
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const rows = await dbWrite.execute(
              sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${barrierPid}=ANY(pg_blocking_pids(pid)) AND query ILIKE ${'%insert into "' + table + '"%'}`
            );
            if (rows.length) {
              firstPid = Number(rows[0]?.pid);
              break;
            }
            await Bun.sleep(25);
          }
          expect(firstPid).toBeGreaterThan(0);
          requests.push(
            first === 'follow'
              ? postBlock(blocker, blocked)
              : postFollow(from, to)
          );
          const allResponses = Promise.all(requests);
          let secondObserved = false;
          const secondDeadline = Date.now() + 10000;
          while (Date.now() < secondDeadline) {
            const completed =
              first === 'follow'
                ? await blockRow(blocker, blocked)
                : await followRow(from, to);
            const rows = await dbWrite.execute(
              sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${firstPid}=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'`
            );
            if (completed || rows.length) {
              secondObserved = true;
              break;
            }
            await Bun.sleep(25);
          }
          expect(secondObserved).toBe(true);
          release.reject(rollback);
          await barrierDone;
          const responses = await allResponses;
          const followResponse = responses[first === 'follow' ? 0 : 1]!;
          const blockResponse = responses[first === 'follow' ? 1 : 0]!;
          expect(blockResponse.status).toBe(200);
          expect(followResponse.status).toBe(first === 'follow' ? 201 : 400);
          expect(await blockRow(blocker, blocked)).not.toBeNull();
          expect(await followRow(from, to)).toBeNull();
          expect(await followRow(to, from)).toBeNull();
        } finally {
          release.reject(rollback);
          await barrierDone;
          await Promise.allSettled(requests);
        }
      }, 45000);
    }
  }
});
