/**
 * MCP get_followers / get_following return the same population as the
 * website follow lists: only real users who are not test accounts
 * (isTest flag or 'test-' id prefix) and not banned. Follow rows whose
 * other side no longer exists must not appear as null-username entries,
 * and excluded rows must not consume page slots.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, follows, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeGetFollowers,
  executeGetFollowing,
} from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const followIds: string[] = [];

let agentUserId: string;
let targetId: string;
let sourceId: string;
let normalAId: string;
let normalBId: string;

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f185_${id.replace(/-/g, '').slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
      ...overrides,
    })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  userIds.push(inserted[0].id);
  return inserted[0].id;
}

async function createFollow(
  followerId: string,
  followingId: string,
  createdAt: Date
): Promise<void> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(follows)
    .values({ id, followerId, followingId, createdAt })
    .returning({ id: follows.id });
  if (!inserted[0]) throw new Error('Follow fixture insert returned no row');
  followIds.push(inserted[0].id);
}

describe('MCP follow list population', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    targetId = await createUser();
    sourceId = await createUser();
    normalAId = await createUser();
    normalBId = await createUser();
    const isTestId = await createUser({ isTest: true });
    const testPrefixId = await createUser({
      id: `test-${crypto.randomUUID()}`,
    });
    const bannedId = await createUser({ isBanned: true });
    // A follow row whose other side has no User row at all.
    const ghostId = crypto.randomUUID();

    const base = Date.now() - 60_000;
    // Excluded rows are the newest, so an unfiltered take of any size
    // surfaces them first; the valid rows are the oldest.
    const members: Array<[string, number]> = [
      [normalAId, 0],
      [normalBId, 10_000],
      [isTestId, 20_000],
      [testPrefixId, 30_000],
      [bannedId, 40_000],
      [ghostId, 50_000],
    ];
    for (const [memberId, offset] of members) {
      const at = new Date(base + offset);
      await createFollow(memberId, targetId, at); // member follows target
      await createFollow(sourceId, memberId, at); // source follows member
    }
  });

  afterAll(async () => {
    if (followIds.length > 0) {
      await db.delete(follows).where(inArray(follows.id, followIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    const leftoverFollows =
      followIds.length > 0
        ? await db
            .select({ id: follows.id })
            .from(follows)
            .where(inArray(follows.id, followIds))
        : [];
    const leftoverUsers =
      userIds.length > 0
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.id, userIds))
        : [];
    expect(leftoverFollows).toEqual([]);
    expect(leftoverUsers).toEqual([]);
  });

  it('get_followers returns only real, non-test, non-banned users', async () => {
    const result = await executeGetFollowers(agent(), { userId: targetId });
    expect(result.followers.map((f) => f.id)).toEqual([normalBId, normalAId]);
    expect(result.followers.every((f) => f.username !== null)).toBe(true);
  });

  it('get_followers applies the population filter before the limit', async () => {
    const result = await executeGetFollowers(agent(), {
      userId: targetId,
      limit: 2,
    });
    expect(result.followers.map((f) => f.id)).toEqual([normalBId, normalAId]);
  });

  it('get_following returns only real, non-test, non-banned users', async () => {
    const result = await executeGetFollowing(agent(), { userId: sourceId });
    expect(result.following.map((f) => f.id)).toEqual([normalBId, normalAId]);
    expect(result.following.every((f) => f.username !== null)).toBe(true);
  });

  it('get_following applies the population filter before the limit', async () => {
    const result = await executeGetFollowing(agent(), {
      userId: sourceId,
      limit: 2,
    });
    expect(result.following.map((f) => f.id)).toEqual([normalBId, normalAId]);
  });
});
