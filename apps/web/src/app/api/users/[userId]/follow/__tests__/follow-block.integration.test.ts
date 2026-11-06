/**
 * POST /api/users/[userId]/follow against a real database: creating a block
 * deletes the follow relationships between the two users in both directions
 * (see the block route), so neither side may recreate the edge while the
 * block stands. The comment and share POSTs already reject interactions
 * across a block with BLOCKED_USER; the follow POST must do the same.
 *
 * Fixture rows are namespaced by a per-run id and are not deleted.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { and, db, eq, follows, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let userAId: string; // blocked userB
let userBId: string; // was blocked by userA
let userCId: string; // control: no block relationship with anyone
let userDId: string; // blocked userE
let userEId: string; // was blocked by userD
let currentUserId: string;

let POST: typeof import('../route').POST;

beforeAll(async () => {
  // Real-database fixture setup; exceeds the default 5s hook timeout.
  [userAId, userBId, userCId, userDId, userEId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const apiIndex = path.resolve(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages/api/src/index.ts'
  );
  const actualApi = await import(apiIndex);
  mock.module('@feed/api', () => ({
    ...actualApi,
    authenticate: async () => ({ userId: currentUserId }),
  }));
  mock.module('@/lib/posthog/server', () => ({
    trackServerEvent: async () => {},
  }));
  ({ POST } = await import('../route'));

  const runId = await generateSnowflakeId();
  const now = new Date();
  await db.insert(users).values(
    [userAId, userBId, userCId, userDId, userEId].map((id) => ({
      id,
      username: `test-followblock-${runId}-${id}`,
      displayName: 'Follow block fixture',
      updatedAt: now,
    }))
  );

  await db.insert(userBlocks).values([
    {
      id: await generateSnowflakeId(),
      blockerId: userAId,
      blockedId: userBId,
    },
    {
      id: await generateSnowflakeId(),
      blockerId: userDId,
      blockedId: userEId,
    },
  ]);
}, 120_000);

async function postFollow(followerId: string, targetId: string) {
  currentUserId = followerId;
  return POST(
    new NextRequest(`https://feed.example/api/users/${targetId}/follow`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ userId: targetId }) }
  );
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

describe('POST /api/users/[userId]/follow block enforcement', () => {
  it('rejects a follow from a user the target has blocked', async () => {
    const response = await postFollow(userBId, userAId);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Cannot follow this user');
    expect(await followRow(userBId, userAId)).toBeNull();
  });

  it('rejects a follow toward a user the follower has blocked', async () => {
    const response = await postFollow(userAId, userBId);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Cannot follow this user');
    expect(await followRow(userAId, userBId)).toBeNull();
  });

  it('rejects a follow when the block is in the other pair direction', async () => {
    const response = await postFollow(userEId, userDId);
    expect(response.status).toBe(400);
    expect(await followRow(userEId, userDId)).toBeNull();
  });

  it('still allows a follow with no block relationship', async () => {
    const response = await postFollow(userCId, userAId);
    expect(response.status).toBe(201);
    expect(await followRow(userCId, userAId)).not.toBeNull();
  });
});
