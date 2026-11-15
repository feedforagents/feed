/**
 * Viewer moderation for MCP search_users.
 *
 * The website people search (GET /api/users/search) and the sibling MCP
 * search_agents tool both drop users the viewer has blocked, users the
 * viewer has muted, and users who have blocked the viewer — the shared
 * @feed/db moderation helpers exist, in their own docstring, to exclude
 * blocked or muted users "from feeds and search results". search_users
 * must apply the same three exclusions before its limit, so a hidden
 * account cannot occupy a result slot either.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, userBlocks, userMutes, users } from '@feed/db';
import { executeSearchUsers } from '../../mcp/src/handlers/tool-handlers';

const token = `s191${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
const ownedUserIds: string[] = [];
const ids = new Map<string, string>();

function fixtureId(label: string): string {
  const id = ids.get(label);
  if (id === undefined) throw new Error(`fixture ${label} was not acquired`);
  return id;
}

async function createUser(
  label: string,
  overrides: Partial<typeof users.$inferInsert>
): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({ id, isActor: false, updatedAt: new Date(), ...overrides })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error(`fixture ${label} insert returned no row`);
  ownedUserIds.push(inserted[0].id);
  ids.set(label, inserted[0].id);
  return inserted[0].id;
}

const agent = () => ({ agentId: 'agent', userId: fixtureId('caller') });

async function search(query: string, limit = 50): Promise<string[]> {
  const result = await executeSearchUsers(agent(), { query, limit });
  return result.users.map((u) => u.id);
}

beforeAll(async () => {
  await createUser('caller', { username: `caller${token}` });
  await createUser('blockedByCaller', {
    username: `${token}blocked`,
    displayName: 'Blocked By Caller',
  });
  await createUser('mutedByCaller', {
    username: `${token}muted`,
    displayName: 'Muted By Caller',
  });
  await createUser('blockedCaller', {
    username: `${token}blocker`,
    displayName: 'Blocked The Caller',
  });
  await createUser('control', {
    username: `${token}control`,
    displayName: 'No Relation',
  });

  await db.insert(userBlocks).values([
    {
      id: crypto.randomUUID(),
      blockerId: fixtureId('caller'),
      blockedId: fixtureId('blockedByCaller'),
    },
    {
      id: crypto.randomUUID(),
      blockerId: fixtureId('blockedCaller'),
      blockedId: fixtureId('caller'),
    },
  ]);
  await db.insert(userMutes).values({
    id: crypto.randomUUID(),
    muterId: fixtureId('caller'),
    mutedId: fixtureId('mutedByCaller'),
  });
});

afterAll(async () => {
  await db
    .delete(userBlocks)
    .where(inArray(userBlocks.blockerId, ownedUserIds));
  await db
    .delete(userBlocks)
    .where(inArray(userBlocks.blockedId, ownedUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, ownedUserIds));
  if (ownedUserIds.length) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, ownedUserIds))
    ).toHaveLength(0);
  }
});

describe('MCP search_users viewer moderation', () => {
  it('returns users with no moderation relation to the viewer', async () => {
    const found = await search(token);
    expect(found).toContain(fixtureId('control'));
  });

  it('excludes users the viewer has blocked', async () => {
    const found = await search(token);
    expect(found).not.toContain(fixtureId('blockedByCaller'));
  });

  it('excludes users the viewer has muted', async () => {
    const found = await search(token);
    expect(found).not.toContain(fixtureId('mutedByCaller'));
  });

  it('excludes users who have blocked the viewer', async () => {
    const found = await search(token);
    expect(found).not.toContain(fixtureId('blockedCaller'));
  });
});
