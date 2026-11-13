/**
 * MCP search_agents membership: test accounts must not be returned.
 *
 * search_agents is the MCP tool an agent client uses to find NPCs and
 * agents by name. The platform membership rule (DatabaseService) treats
 * an account as a test account when it carries the isTest flag OR its id
 * starts with 'test-' — test NPCs bootstrapped into User rows keep the
 * prefix but not the flag. Every user-facing surface hides test accounts
 * (merged A2A users.search states the rule verbatim), and the sibling
 * MCP people search applies the same two exclusions. search_agents
 * already excludes banned accounts and the viewer's blocks/mutes, but
 * not test accounts, so test NPCs and test agents occupy result slots
 * and are presented as real interaction targets.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, db, inArray, users } from '@feed/db';
import { executeSearchAgents } from '../../mcp/src/handlers/tool-handlers';

const ownedIds: string[] = [];
const token = `f140seek${Math.floor(Math.random() * 1e9)}`;
let viewerId: string;
let npcVisibleId: string;
let agentVisibleId: string;

async function createUser(
  overrides: Partial<typeof users.$inferInsert> & { id?: string }
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `${token}_${id.slice(-8)}`,
      updatedAt: new Date(),
      ...overrides,
    })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  ownedIds.push(inserted[0].id);
  return inserted[0].id;
}

beforeAll(async () => {
  viewerId = await createUser({});
  npcVisibleId = await createUser({ isActor: true });
  agentVisibleId = await createUser({ isAgent: true });
  // Test accounts by the isTest flag.
  await createUser({ isActor: true, isTest: true });
  await createUser({ isAgent: true, isTest: true });
  // Test accounts by the 'test-' id prefix alone (the bootstrap shape:
  // NPC User rows are created from pack actors without copying isTest).
  await createUser({ id: `test-${crypto.randomUUID()}`, isActor: true });
  await createUser({ id: `test-${crypto.randomUUID()}`, isAgent: true });
  // Banned accounts are already excluded on the base — control fixture.
  await createUser({ isActor: true, isBanned: true });
});

afterAll(async () => {
  if (ownedIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedIds));
  }
  await closeDatabase();
});

describe('MCP search_agents membership', () => {
  it('returns real NPCs and agents but no test or banned accounts', async () => {
    const result = await executeSearchAgents(
      { agentId: 'agent', userId: viewerId },
      { query: token, limit: 20 }
    );
    const ids = result.agents.map((a) => a.id);
    expect(ids).toContain(npcVisibleId);
    expect(ids).toContain(agentVisibleId);
    // Every other fixture shares the query token, so any additional id in
    // the result is a leaked test or banned account.
    expect(ids.sort()).toEqual([npcVisibleId, agentVisibleId].sort());
    const npc = result.agents.find((a) => a.id === npcVisibleId);
    expect(npc?.type).toBe('npc');
    const agent = result.agents.find((a) => a.id === agentVisibleId);
    expect(agent?.type).toBe('agent');
  });
});
