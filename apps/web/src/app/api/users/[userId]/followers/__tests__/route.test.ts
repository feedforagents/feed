import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Route wiring only; the SQL itself is covered by the real-database
// actor-pagination integration test. Database results below are mocked.
const FOLLOWER_COUNT = 5;

// db.execute results in call order: the relation page (page=2, limit=2),
// then the relation count.
const executeResults: object[][] = [];
// db.select results in call order: page profiles, then the viewer's follows.
const selectResults: object[][] = [];
function chain(result: () => object[]) {
  const node = {
    from: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    then: (resolve: (value: object[]) => void) => resolve(result()),
  };
  return node;
}

const apiModulePath = new URL(
  '../../../../../../../../../packages/api/src/index.ts',
  import.meta.url
).pathname;
const apiModuleFactory = () => ({
  optionalAuth: async () => ({ userId: 'viewer' }),
  requireTargetByIdentifier: async () => ({ actor: null, targetId: 'target' }),
  successResponse: (body: object) => Response.json(body),
  withErrorHandling: (handler: (...args: never[]) => unknown) => handler,
});
const dbModulePath = new URL(
  '../../../../../../../../../packages/db/src/index.ts',
  import.meta.url
).pathname;
const inArrayCalls: string[][] = [];
const sqlTag = Object.assign(() => ({}), { join: () => ({}) });
const dbModuleFactory = () => ({
  actorFollows: {},
  and: () => undefined,
  db: {
    execute: async () => executeResults.shift() ?? [],
    select: () => chain(() => selectResults.shift() ?? []),
  },
  eq: () => undefined,
  followStatuses: {},
  follows: {},
  inArray: (_column: object, ids: string[]) => {
    inArrayCalls.push(ids);
    return undefined;
  },
  sql: sqlTag,
  userActorFollows: {},
  users: {},
});
// The target is a regular user and the page has no NPC followers, so the
// route only needs StaticDataRegistry to exist.
const engineModulePath = new URL(
  '../../../../../../../../../packages/engine/src/index.ts',
  import.meta.url
).pathname;
const engineModuleFactory = () => ({
  StaticDataRegistry: { getActor: () => null, getAllActors: () => [] },
});

mock.module('@feed/api', apiModuleFactory);
mock.module(apiModulePath, apiModuleFactory);
mock.module('@feed/db', dbModuleFactory);
mock.module(dbModulePath, dbModuleFactory);
mock.module('@feed/engine', engineModuleFactory);
mock.module(engineModulePath, engineModuleFactory);

describe('GET /api/users/[userId]/followers', () => {
  it('hydrates only the page and reports total and hasMore', async () => {
    executeResults.push(
      [
        {
          src: 0,
          member_id: 'user-2',
          followed_at: '2026-01-08T00:00:00.000Z',
        },
        {
          src: 0,
          member_id: 'user-3',
          followed_at: '2026-01-07T00:00:00.000Z',
        },
      ],
      [{ total: FOLLOWER_COUNT }]
    );
    selectResults.push(
      [
        {
          id: 'user-3',
          displayName: 'User 3',
          username: 'user3',
          profileImageUrl: null,
          bio: null,
        },
        {
          id: 'user-2',
          displayName: 'User 2',
          username: 'user2',
          profileImageUrl: null,
          bio: null,
        },
      ],
      [{ followingId: 'user-2' }]
    );
    const { GET } = await import('../route');
    const response = await GET(
      new NextRequest(
        'https://feed.example/api/users/target/followers?page=2&limit=2'
      ),
      { params: Promise.resolve({ userId: 'target' }) }
    );
    const body = (await response.json()) as {
      followers: Array<{
        id: string;
        username: string | null;
        viewerFollows?: boolean;
      }>;
      count: number;
      hasMore: boolean;
    };

    // Relation order is kept even though profiles came back in another order.
    expect(body.followers.map((f) => f.id)).toEqual(['user-2', 'user-3']);
    expect(body.followers.map((f) => f.username)).toEqual(['user2', 'user3']);
    expect(body.count).toBe(FOLLOWER_COUNT);
    expect(body.hasMore).toBe(true);
    // Profile and viewer-follow lookups only cover the returned page.
    expect(inArrayCalls).toEqual([
      ['user-2', 'user-3'],
      ['user-2', 'user-3'],
    ]);
    expect(body.followers[0]?.viewerFollows).toBe(true);
    expect(body.followers[1]?.viewerFollows).toBe(false);
  });
});
