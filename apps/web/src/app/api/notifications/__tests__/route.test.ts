import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const cacheKeys: string[] = [];
const offsets: number[] = [];
const limits: number[] = [];
let blocked: string[] = [];

const listChain = {
  from: () => listChain,
  where: () => listChain,
  orderBy: () => listChain,
  limit: (n: number) => {
    limits.push(n);
    return listChain;
  },
  offset: async (n: number) => {
    offsets.push(n);
    return [];
  },
};
const countChain = {
  from: () => countChain,
  where: async () => [{ count: 0 }],
};

const apiModulePath = new URL(
  '../../../../../../../packages/api/src/index.ts',
  import.meta.url
).pathname;
const apiModuleFactory = () => ({
  authenticate: async () => ({ userId: 'u1', dbUserId: 'u1' }),
  CACHE_KEYS: { USER: 'user' },
  getCacheOrFetch: async (key: string, fetcher: () => Promise<object>) => {
    cacheKeys.push(key);
    return fetcher();
  },
  InternalServerError: Error,
  invalidateCachePattern: async () => undefined,
  successResponse: (body: object) => Response.json(body),
  withErrorHandling: (handler: (...args: never[]) => unknown) => handler,
});

const dbModulePath = new URL(
  '../../../../../../../packages/db/src/index.ts',
  import.meta.url
).pathname;
const dbModuleFactory = () => ({
  and: () => undefined,
  count: () => undefined,
  db: {
    select: (fields?: object) =>
      fields && 'count' in fields ? countChain : listChain,
  },
  desc: () => undefined,
  eq: () => undefined,
  exists: () => undefined,
  getBlockedByUserIds: async () => [],
  getBlockedUserIds: async () => blocked,
  getMutedUserIds: async () => [],
  inArray: () => undefined,
  isNull: () => undefined,
  notifications: {},
  notInArray: () => undefined,
  or: () => undefined,
  comments: { id: 'commentId' },
  posts: { id: 'postId' },
  users: {},
});

mock.module('@feed/api', apiModuleFactory);
mock.module(apiModulePath, apiModuleFactory);
mock.module('@feed/db', dbModuleFactory);
mock.module(dbModulePath, dbModuleFactory);

describe('GET /api/notifications', () => {
  beforeEach(() => {
    cacheKeys.length = 0;
    offsets.length = 0;
    limits.length = 0;
    blocked = [];
  });

  it('applies page as an offset and includes it in the cache key', async () => {
    const { GET } = await import('../route');
    await GET(
      new NextRequest('https://feed.example/api/notifications?limit=10&page=1')
    );
    await GET(
      new NextRequest('https://feed.example/api/notifications?limit=10&page=3')
    );

    expect(offsets).toEqual([0, 20]);
    expect(limits).toEqual([10, 10]);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('treats unreadOnly=false as false', async () => {
    const { GET } = await import('../route');
    await GET(
      new NextRequest('https://feed.example/api/notifications?unreadOnly=false')
    );
    expect(cacheKeys[0]).toContain(':false:');
  });

  it('changes the cache key when the moderation set changes', async () => {
    const { GET } = await import('../route');
    await GET(new NextRequest('https://feed.example/api/notifications'));
    blocked = ['someone'];
    await GET(new NextRequest('https://feed.example/api/notifications'));
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });
});
