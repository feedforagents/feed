import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const FOLLOWER_COUNT = 5;
const followerRows = Array.from({ length: FOLLOWER_COUNT }, (_, i) => ({
  id: `f${i}`,
  followerId: `user-${i}`,
  createdAt: new Date(Date.UTC(2026, 0, 10 - i)),
  followerDisplayName: `User ${i}`,
  followerUsername: `user${i}`,
  followerProfileImageUrl: null,
  followerBio: null,
}));

// Query results in call order: user follows, NPC follow statuses,
// then the viewer's follows of the paged followers.
const queryResults: object[][] = [];
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
const viewerFollowQueries: string[][] = [];
const dbModuleFactory = () => ({
  actorFollows: {},
  and: () => undefined,
  db: {
    select: () => chain(() => queryResults.shift() ?? []),
  },
  desc: () => undefined,
  eq: () => undefined,
  followStatuses: {},
  follows: {},
  inArray: (_column: object, ids: string[]) => {
    viewerFollowQueries.push(ids);
    return undefined;
  },
  not: () => undefined,
  userActorFollows: {},
  users: {},
});
// The target is a regular user with no NPC followers, so the route only
// needs StaticDataRegistry to exist; mocking it avoids loading the engine barrel.
const engineModulePath = new URL(
  '../../../../../../../../../packages/engine/src/index.ts',
  import.meta.url
).pathname;
const engineModuleFactory = () => ({
  StaticDataRegistry: { getActor: () => null },
});

mock.module('@feed/api', apiModuleFactory);
mock.module(apiModulePath, apiModuleFactory);
mock.module('@feed/db', dbModuleFactory);
mock.module(dbModulePath, dbModuleFactory);
mock.module('@feed/engine', engineModuleFactory);
mock.module(engineModulePath, engineModuleFactory);

describe('GET /api/users/[userId]/followers', () => {
  it('applies page/limit and reports total and hasMore', async () => {
    queryResults.push(followerRows, [], [{ followingId: 'user-2' }]);
    const { GET } = await import('../route');
    const response = await GET(
      new NextRequest(
        'https://feed.example/api/users/target/followers?page=2&limit=2'
      ),
      { params: Promise.resolve({ userId: 'target' }) }
    );
    const body = (await response.json()) as {
      followers: Array<{ id: string; viewerFollows?: boolean }>;
      count: number;
      hasMore: boolean;
    };

    expect(body.followers.map((f) => f.id)).toEqual(['user-2', 'user-3']);
    expect(body.count).toBe(FOLLOWER_COUNT);
    expect(body.hasMore).toBe(true);
    // Viewer-follow hydration only covers the returned page.
    expect(viewerFollowQueries.at(-1)).toEqual(['user-2', 'user-3']);
    expect(body.followers[0]?.viewerFollows).toBe(true);
    expect(body.followers[1]?.viewerFollows).toBe(false);
  });
});
