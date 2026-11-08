/**
 * GET /api/moderation/blocks and GET /api/moderation/mutes against a real
 * database: the settings moderation lists must load, and must only count
 * and page users that still exist.
 *
 * At base the lists never load at all. Both routes read through
 * `findMany({ include: { blocked|muted: { select: … } } })`, and the db
 * client's include builder turns the select fields into nested relation
 * lookups, so Drizzle throws (`relation.referencedTable`) and every
 * authenticated request returns 500 — the settings page can only show
 * its "Couldn't load" error state, and no one can review or undo a
 * block/mute from settings. (Reading the relation with `include: true`
 * instead is not a way out either: the User table has more than 100
 * columns and the generated json_build_array exceeds Postgres's
 * function-argument limit.)
 *
 * Behind that, the rows themselves can outlive their target. The
 * UserBlock and UserMute tables have no foreign key to User (the fresh
 * baseline adds only a unique constraint and indexes), and the
 * account-deletion route (POST /api/users/delete-account) removes the
 * user row without touching block/mute rows that point at it — its
 * cleanup relies on cascades that do not exist for these tables. So when
 * a blocked or muted account is deleted, the row survives as an orphan
 * and must not count toward `pagination.total` or spend a pagination
 * slot: the settings page drops target-less entries before rendering,
 * so an orphan inside the first page would silently push a real entry
 * past the only page the page ever fetches — that person would stay
 * blocked/muted but could no longer be seen or unblocked/unmuted from
 * settings.
 *
 * The request is authenticated with the existing CI synthetic bearer. The
 * only stub is the `server-only` marker package (an empty environment
 * guard that throws outside a Server Component); every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, inArray, userBlocks, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type BlocksResponse = {
  blocks: Array<{
    id: string;
    blockedId: string;
    blocked: { id: string } | null;
  }>;
  pagination: { limit: number; offset: number; total: number };
};

type MutesResponse = {
  mutes: Array<{
    id: string;
    mutedId: string;
    muted: { id: string } | null;
  }>;
  pagination: { limit: number; offset: number; total: number };
};

let viewerId: string;
let blockAId: string;
let blockBId: string;
let blockGhostId: string;
let muteRealId: string;
let muteGhostId: string;

let blocksGET: typeof import('../../../apps/web/src/app/api/moderation/blocks/route').GET;
let mutesGET: typeof import('../../../apps/web/src/app/api/moderation/mutes/route').GET;

async function fetchBlocks(query = '') {
  const request = new NextRequest(
    new Request(`http://localhost/api/moderation/blocks${query}`),
    {
      headers: {
        authorization: `Bearer steward:test:${viewerId}`,
      },
    }
  );
  const response = await blocksGET(request);
  const body = (await response.json().catch(() => null)) as BlocksResponse;
  return { status: response.status, body };
}

async function fetchMutes(query = '') {
  const request = new NextRequest(
    new Request(`http://localhost/api/moderation/mutes${query}`),
    {
      headers: {
        authorization: `Bearer steward:test:${viewerId}`,
      },
    }
  );
  const response = await mutesGET(request);
  const body = (await response.json().catch(() => null)) as MutesResponse;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET: blocksGET } = await import(
    '../../../apps/web/src/app/api/moderation/blocks/route'
  ));
  ({ GET: mutesGET } = await import(
    '../../../apps/web/src/app/api/moderation/mutes/route'
  ));

  [viewerId, blockAId, blockBId, blockGhostId, muteRealId, muteGhostId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

  const now = Date.now();
  const t = (msAgo: number) => new Date(now - msAgo);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f15v-${viewerId}`,
      displayName: 'Orphan Fixture Viewer',
      updatedAt: t(0),
    },
    {
      id: blockAId,
      username: `f15a-${blockAId}`,
      displayName: 'Blocked Author A',
      updatedAt: t(0),
    },
    {
      id: blockBId,
      username: `f15b-${blockBId}`,
      displayName: 'Blocked Author B',
      updatedAt: t(0),
    },
    {
      id: blockGhostId,
      username: `f15g-${blockGhostId}`,
      displayName: 'Soon Deleted Blocked',
      updatedAt: t(0),
    },
    {
      id: muteRealId,
      username: `f15m-${muteRealId}`,
      displayName: 'Muted Author',
      updatedAt: t(0),
    },
    {
      id: muteGhostId,
      username: `f15h-${muteGhostId}`,
      displayName: 'Soon Deleted Muted',
      updatedAt: t(0),
    },
  ]);

  // Block order (newest first): ghost, author B, author A.
  await db.insert(userBlocks).values([
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: blockAId,
      createdAt: t(30_000),
    },
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: blockBId,
      createdAt: t(20_000),
    },
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: blockGhostId,
      createdAt: t(10_000),
    },
  ]);

  // Mute order (newest first): ghost, real author.
  await db.insert(userMutes).values([
    {
      id: await generateSnowflakeId(),
      muterId: viewerId,
      mutedId: muteRealId,
      createdAt: t(20_000),
    },
    {
      id: await generateSnowflakeId(),
      muterId: viewerId,
      mutedId: muteGhostId,
      createdAt: t(10_000),
    },
  ]);

  // Both ghosts delete their accounts. Account deletion removes the user
  // rows and never touches UserBlock/UserMute (no FK, no explicit
  // cleanup), so the rows above survive pointing at users that are gone.
  await db.delete(users).where(inArray(users.id, [blockGhostId, muteGhostId]));
});

afterAll(async () => {
  await db.delete(userBlocks).where(eq(userBlocks.blockerId, viewerId));
  await db.delete(userMutes).where(eq(userMutes.muterId, viewerId));
  await db
    .delete(users)
    .where(inArray(users.id, [viewerId, blockAId, blockBId, muteRealId]));
});

describe('GET /api/moderation/blocks with an orphaned block', () => {
  it('counts and returns only blocks whose user still exists', async () => {
    const { status, body } = await fetchBlocks();
    expect(status).toBe(200);
    // The orphaned block must not inflate the total.
    expect(body.pagination.total).toBe(2);
    expect(body.blocks).toHaveLength(2);
    // No entry may carry a null user.
    expect(body.blocks.every((b) => b.blocked !== null)).toBe(true);
    expect(body.blocks.map((b) => b.blockedId).sort()).toEqual(
      [blockAId, blockBId].sort()
    );
  });

  it('keeps every real block reachable while paging', async () => {
    const seen: string[] = [];
    for (const offset of [0, 1, 2]) {
      const { status, body } = await fetchBlocks(`?limit=1&offset=${offset}`);
      expect(status).toBe(200);
      expect(body.pagination.total).toBe(2);
      for (const block of body.blocks) {
        expect(block.blocked).not.toBeNull();
        seen.push(block.blockedId);
      }
    }
    // Newest first, each exactly once; offset 2 is past the end.
    expect(seen).toEqual([blockBId, blockAId]);
  });
});

describe('GET /api/moderation/mutes with an orphaned mute', () => {
  it('counts and returns only mutes whose user still exists', async () => {
    const { status, body } = await fetchMutes();
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(1);
    expect(body.mutes).toHaveLength(1);
    expect(body.mutes[0]?.muted).not.toBeNull();
    expect(body.mutes[0]?.mutedId).toBe(muteRealId);
  });
});
