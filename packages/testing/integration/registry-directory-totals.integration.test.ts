/**
 * GET /api/registry/all (the entity directory behind the admin Registry
 * tab) against a real database: the header totals must be real counts of
 * registered entities, not the lengths of the capped lists.
 *
 * The route's own documentation says it "Fetches ALL entities", the tab
 * renders the totals under "Browse all registered entities in the Feed
 * ecosystem" with Total/Users/Actors labels, and the sibling directory
 * route (GET /api/registry) counts the same kind of total for real —
 * `db.user.count({ where })` returned as `pagination.total`. This route
 * instead caps the users list at the newest 100 (`take: 100`) and the
 * actors list at the top 100 by reputation, then reports the capped
 * array lengths as `totals`. As soon as more than 100 users are
 * registered, the directory's Users number and the grand Total understate
 * the registry, and the same happens to a search whose matches exceed
 * the cap. The lists themselves stay capped either way — only the
 * reported counts are wrong.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type RegistryAllResponse = {
  users: Array<{ id: string }>;
  actors: Array<{ id: string }>;
  agents: Array<unknown>;
  apps: Array<unknown>;
  totals: {
    users: number;
    actors: number;
    agents: number;
    apps: number;
    total: number;
  };
};

let GET: typeof import('../../../apps/web/src/app/api/registry/all/route').GET;

const FIXTURE_COUNT = 105;
const fixtureUserIds: string[] = [];
// Unique per run so the search assertion counts only this run's fixtures
// even if an interrupted earlier run left rows behind.
const runMarker = `f110-dir-${Math.random().toString(36).slice(2, 8)}`;
let usersBefore = 0;
let staticActorCount = 0;

async function fetchRegistryAll(search?: string) {
  const url = search
    ? `http://localhost/api/registry/all?search=${encodeURIComponent(search)}`
    : 'http://localhost/api/registry/all';
  const request = new NextRequest(new Request(url));
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | RegistryAllResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body: body as RegistryAllResponse };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/registry/all/route'));

  usersBefore = (await db.select({ id: users.id }).from(users)).length;
  staticActorCount = StaticDataRegistry.getAllActors().length;

  // 105 users with distinct creation times, oldest first: the route's
  // createdAt-desc list keeps the newest 100, so the 5 oldest fall
  // outside the returned list but must still be counted in the totals.
  const baseTime = Date.now() - FIXTURE_COUNT * 60_000;
  const rows = [];
  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const id = await generateSnowflakeId();
    fixtureUserIds.push(id);
    const at = new Date(baseTime + i * 60_000);
    rows.push({
      id,
      username: `${runMarker}-${i}-${id}`,
      displayName: `F110 Directory User ${i}`,
      createdAt: at,
      updatedAt: at,
    });
  }
  await db.insert(users).values(rows);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, fixtureUserIds));
});

describe('GET /api/registry/all directory totals', () => {
  it('premise: the fixture users exist and the list cap binds', async () => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, fixtureUserIds));
    expect(rows).toHaveLength(FIXTURE_COUNT);
    expect(usersBefore + FIXTURE_COUNT).toBeGreaterThan(100);
  });

  it('reports the real registered user count, not the capped list length', async () => {
    const { status, body } = await fetchRegistryAll();
    expect(status).toBe(200);
    // The list itself stays capped at the newest 100.
    expect(body.users).toHaveLength(100);
    expect(body.totals.users).toBe(usersBefore + FIXTURE_COUNT);
    expect(body.totals.total).toBe(
      body.totals.users +
        body.totals.actors +
        body.totals.agents +
        body.totals.apps
    );
  });

  it('reports the real matching count for a search past the cap', async () => {
    const { status, body } = await fetchRegistryAll(runMarker);
    expect(status).toBe(200);
    expect(body.users).toHaveLength(100);
    expect(body.totals.users).toBe(FIXTURE_COUNT);
  });

  it('keeps the actor, agent and app totals at their real counts', async () => {
    const { status, body } = await fetchRegistryAll();
    expect(status).toBe(200);
    expect(body.totals.actors).toBe(staticActorCount);
    expect(body.totals.agents).toBe(0);
    expect(body.totals.apps).toBe(0);
  });
});
