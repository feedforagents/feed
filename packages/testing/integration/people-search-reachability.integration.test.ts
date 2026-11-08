/**
 * GET /api/users/search against a real database: people search must let a
 * caller page past the first 20 matches.
 *
 * The route ranks matches in tiers (exact username, then prefix matches,
 * then substring matches) and stops at 20 results. It accepts no offset,
 * page, or cursor parameter, so matches ranked past the first window can
 * never be listed. For username-prefix families a caller can sometimes
 * refine the query, but for namesakes — many real people sharing one
 * display name, with unrelated usernames — every name-based query returns
 * the same first 20 (ordered by username) and the rest are unreachable by
 * any query that does not already know their username. The group member
 * pickers (CreateGroupModal, GroupManagementModal) are the wired callers:
 * a person who never appears in results can never be added to a group.
 *
 * Sibling list surfaces page with an offset (#1731 messaging.get_chats,
 * the A2A leaderboard fix). This suite drives the real route, imported
 * directly (the pattern used by user-search-test-accounts.integration
 * .test.ts), with the dev x-dev-user-id bypass and rate limiting disabled
 * through the supported test switch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

process.env.DISABLE_RATE_LIMITING = 'true';

type SearchResponse = {
  users: Array<{ id: string; username: string }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/search/route').GET;

const NAMESAKES = 300;
const FAMILY = 60;
const PAGE = 20;

let suffix: string;
let viewerId: string;
let namesakeToken: string;
let familyToken: string;
const ownedIds: string[] = [];
const namesakeIds: string[] = [];
const familyIds: string[] = [];
let targetNamesakeId: string;

async function search(q: string, extra = ''): Promise<SearchResponse> {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/users/search?q=${encodeURIComponent(q)}${extra}`,
      {
        headers: { 'x-dev-user-id': viewerId },
      }
    )
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResponse;
}

async function walkAll(
  q: string,
  total: number
): Promise<{ ids: string[]; pages: string[][] }> {
  const ids: string[] = [];
  const pages: string[][] = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const { users: found } = await search(q, `&offset=${offset}`);
    const pageIds = found.map((u) => u.id);
    pages.push(pageIds);
    ids.push(...pageIds);
  }
  return { ids, pages };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/users/search/route'));

  suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  namesakeToken = `namesake${suffix}`;
  familyToken = `fam${suffix}`;
  viewerId = await generateSnowflakeId();
  ownedIds.push(viewerId);

  const now = new Date();
  const rows: Array<{
    id: string;
    username: string;
    displayName?: string;
    updatedAt: Date;
  }> = [{ id: viewerId, username: `viewer${suffix}`, updatedAt: now }];

  // 300 namesakes: one shared display name, unrelated usernames that do
  // not contain the display-name token at all.
  for (let i = 1; i <= NAMESAKES; i++) {
    const n = String(i).padStart(4, '0');
    const id = await generateSnowflakeId();
    namesakeIds.push(id);
    ownedIds.push(id);
    rows.push({
      id,
      username: `zz${suffix}u${n}`,
      displayName: namesakeToken,
      updatedAt: now,
    });
  }
  // The namesake ranked 250th by username order.
  targetNamesakeId = namesakeIds[249];

  // 60 accounts sharing one username prefix.
  for (let i = 1; i <= FAMILY; i++) {
    const n = String(i).padStart(4, '0');
    const id = await generateSnowflakeId();
    familyIds.push(id);
    ownedIds.push(id);
    rows.push({
      id,
      username: `${familyToken}${n}`,
      displayName: `Member ${suffix} ${n}`,
      updatedAt: now,
    });
  }

  for (let i = 0; i < rows.length; i += 100) {
    await db.insert(users).values(rows.slice(i, i + 100));
  }
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ownedIds));
});

describe('web people search reachability', () => {
  it('pages through all 300 namesakes exactly once', async () => {
    const { ids } = await walkAll(namesakeToken, NAMESAKES);
    expect(ids.length).toBe(NAMESAKES);
    expect(new Set(ids).size).toBe(NAMESAKES);
    expect(new Set(ids)).toEqual(new Set(namesakeIds));
  });

  it('reaches the namesake ranked 250th by a name-only query', async () => {
    const { ids } = await walkAll(namesakeToken, NAMESAKES);
    expect(ids).toContain(targetNamesakeId);
    expect(ids.indexOf(targetNamesakeId)).toBe(249);
  });

  it('paging order is deterministic across two full walks', async () => {
    const first = await walkAll(namesakeToken, NAMESAKES);
    const second = await walkAll(namesakeToken, NAMESAKES);
    expect(second.ids).toEqual(first.ids);
  });

  it('pages through all 60 username-prefix matches exactly once', async () => {
    const { ids } = await walkAll(familyToken, FAMILY);
    expect(ids.length).toBe(FAMILY);
    expect(new Set(ids)).toEqual(new Set(familyIds));
  });

  it('default call still returns the first window of 20', async () => {
    const { users: found } = await search(namesakeToken);
    expect(found.length).toBe(PAGE);
    expect(found.map((u) => u.id)).toEqual(namesakeIds.slice(0, PAGE));
  });

  it('exact username search still returns that account', async () => {
    const target = `zz${suffix}u0250`;
    const { users: found } = await search(target);
    expect(found.map((u) => u.id)).toEqual([targetNamesakeId]);
  });
});
