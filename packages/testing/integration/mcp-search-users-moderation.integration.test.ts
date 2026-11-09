/**
 * MCP search_users applies the same people-search moderation as the web
 * people search and the A2A users.search lookup (PRD §8.1 same business
 * logic / moderation; §8.2/§12): banned accounts are never returned and
 * test accounts are not real users, on both username and display-name
 * matches, with the exclusions applied before the limit.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { executeSearchUsers } from '../../mcp/src/handlers/tool-handlers';

const token = `s117${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
const ownedIds: string[] = [];
const ids = new Map<string, string>();

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
  ownedIds.push(inserted[0].id);
  ids.set(label, inserted[0].id);
  return inserted[0].id;
}

const agent = () => ({ agentId: 'agent', userId: ids.get('caller')! });

async function search(query: string, limit = 50): Promise<string[]> {
  const result = await executeSearchUsers(agent(), { query, limit });
  return result.users.map((u) => u.id);
}

beforeAll(async () => {
  await createUser('caller', { username: `caller${token}` });
  // Hidden accounts are inserted first so a small-limit search can only
  // fill with eligible rows when the exclusions run before the limit.
  await createUser('bannedName', {
    username: `${token}banned`,
    displayName: 'Banned By Name',
    isBanned: true,
    bannedAt: new Date(),
  });
  await createUser('bannedDisplay', {
    username: `plain${token}a`,
    displayName: `Banned ${token} Display`,
    isBanned: true,
    bannedAt: new Date(),
  });
  await createUser('testName', {
    username: `${token}testacct`,
    displayName: 'Test By Name',
    isTest: true,
  });
  await createUser('testDisplay', {
    username: `plain${token}b`,
    displayName: `Test ${token} Display`,
    isTest: true,
  });
  // A test account by the platform's two-part membership rule
  // (DatabaseService: isTest flag OR an id starting with 'test-') that
  // carries only the id prefix, not the flag.
  const prefixId = `test-${crypto.randomUUID()}`;
  const prefixInserted = await db
    .insert(users)
    .values({
      id: prefixId,
      username: `${token}prefixonly`,
      displayName: 'Prefix Only',
      isActor: false,
      isTest: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!prefixInserted[0]) throw new Error('prefix fixture insert failed');
  ownedIds.push(prefixInserted[0].id);
  ids.set('prefixOnly', prefixInserted[0].id);
  await createUser('normalName', {
    username: `${token}alice`,
    displayName: 'Alice Plain',
  });
  await createUser('normalDisplay', {
    username: `plain${token}c`,
    displayName: `Normal ${token} Display`,
  });
  await createUser('agentUser', {
    username: `${token}agent`,
    displayName: 'Agent Plain',
    isAgent: true,
  });
  await createUser('actorUser', {
    username: `${token}actor`,
    displayName: 'Actor Plain',
    isActor: true,
  });
});

afterAll(async () => {
  if (ownedIds.length) {
    await db.delete(users).where(inArray(users.id, ownedIds));
  }
});

describe('MCP search_users moderation parity', () => {
  it('excludes banned users matched by username or display name', async () => {
    const found = await search(token);
    expect(found).not.toContain(ids.get('bannedName'));
    expect(found).not.toContain(ids.get('bannedDisplay'));
  });

  it('excludes test users matched by username or display name', async () => {
    const found = await search(token);
    expect(found).not.toContain(ids.get('testName'));
    expect(found).not.toContain(ids.get('testDisplay'));
  });

  it('excludes test accounts identified by the test- id prefix alone', async () => {
    const found = await search(token);
    expect(found).not.toContain(ids.get('prefixOnly'));
  });

  it('retains real users, agents and actors', async () => {
    const found = await search(token);
    expect(found).toContain(ids.get('normalName'));
    expect(found).toContain(ids.get('normalDisplay'));
    expect(found).toContain(ids.get('agentUser'));
    expect(found).toContain(ids.get('actorUser'));
  });

  it('fills a small limit with eligible users only', async () => {
    const found = await search(token, 3);
    expect(found).toHaveLength(3);
    expect(found).not.toContain(ids.get('bannedName'));
    expect(found).not.toContain(ids.get('bannedDisplay'));
    expect(found).not.toContain(ids.get('testName'));
    expect(found).not.toContain(ids.get('testDisplay'));
  });

  it('keeps case-insensitive matching on both fields', async () => {
    const found = await search(token.toUpperCase());
    expect(found).toContain(ids.get('normalName'));
    expect(found).toContain(ids.get('normalDisplay'));
  });

  it('returns no invented users for an unmatched query', async () => {
    const found = await search(`nomatch${token}zzz`);
    expect(found).toEqual([]);
  });
});
