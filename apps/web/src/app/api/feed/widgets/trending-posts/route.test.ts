import { describe, expect, it, mock } from 'bun:test';

/**
 * Tests for the Trending Posts widget route with viewer block/mute filtering.
 *
 * The widget uses optionalAuth, so a signed-in viewer must not see posts (or
 * reposts/quotes) by authors they blocked or muted, or by authors who blocked
 * them. Anonymous viewers keep the unfiltered public snapshot.
 */

let currentAuth: { userId: string } | null = { userId: 'viewer-1' };
let excludedAuthorIds = new Set<string>(['blocked-author']);

const now = new Date();

const fixturePosts = [
  {
    id: 'post-a',
    content: 'Post by a blocked author',
    authorId: 'blocked-author',
    originalPostId: null,
    timestamp: now,
  },
  {
    id: 'post-b',
    content: 'Post by a normal author',
    authorId: 'normal-author',
    originalPostId: null,
    timestamp: now,
  },
  {
    id: 'post-c',
    content: 'Repost of a blocked original',
    authorId: 'normal-author',
    originalPostId: 'orig-1',
    timestamp: now,
  },
];

const fixtureUsers = [
  { id: 'blocked-author', username: 'blocked', displayName: 'Blocked Author' },
  { id: 'normal-author', username: 'normal', displayName: 'Normal Author' },
];

const fixtureOriginals = [{ id: 'orig-1', authorId: 'blocked-author' }];

const likeCounts: Record<string, number> = {
  'post-a': 100,
  'post-b': 10,
  'post-c': 50,
};

const fakeDb = {
  post: {
    findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      if (ids) {
        return fixtureOriginals.filter((post) => ids.includes(post.id));
      }
      return fixturePosts;
    },
  },
  reaction: {
    groupBy: async () =>
      Object.entries(likeCounts).map(([postId, count]) => ({
        postId,
        _count: { postId: count },
      })),
  },
  comment: {
    groupBy: async () => [],
  },
  share: {
    groupBy: async () => [],
  },
  user: {
    findMany: async () => fixtureUsers,
  },
};

mock.module('@feed/api', () => ({
  optionalAuth: async () => currentAuth,
  successResponse: (data: unknown) => Response.json(data, { status: 200 }),
  withErrorHandling: (handler: (request: never) => Promise<Response>) => handler,
}));

mock.module('@feed/db', () => ({
  asUser: async (_authUser: unknown, fn: (db: unknown) => Promise<unknown>) =>
    fn(fakeDb),
  asPublic: async (fn: (db: unknown) => Promise<unknown>) => fn(fakeDb),
}));

mock.module('@feed/shared', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  TrendingPostsQuerySchema: { parse: () => ({}) },
  toISO: (date: Date) => date.toISOString(),
}));

mock.module('../../_lib/viewer-moderation', () => ({
  loadViewerExcludedAuthorIds: async () => excludedAuthorIds,
}));

const { GET } = await import('./route');

async function getTrendingPostIds() {
  const request = new Request(
    'http://localhost/api/feed/widgets/trending-posts'
  ) as never;
  const response = await GET(request);
  const body = (await response.json()) as {
    posts: Array<{ id: string; trendingScore: number }>;
  };
  return body.posts.map((post) => post.id);
}

describe('GET /api/feed/widgets/trending-posts viewer moderation', () => {
  it('hides posts by blocked authors', async () => {
    currentAuth = { userId: 'viewer-1' };
    excludedAuthorIds = new Set(['blocked-author']);

    expect(await getTrendingPostIds()).toEqual(['post-b']);
  });

  it('hides reposts of a blocked original', async () => {
    currentAuth = { userId: 'viewer-1' };
    excludedAuthorIds = new Set(['blocked-author']);

    const ids = await getTrendingPostIds();
    expect(ids).not.toContain('post-c');
    expect(ids).toContain('post-b');
  });

  it('anonymous keeps unfiltered snapshot', async () => {
    currentAuth = null;

    expect(await getTrendingPostIds()).toEqual(['post-a', 'post-c', 'post-b']);
  });

  it('viewer excluding nobody keeps all', async () => {
    currentAuth = { userId: 'viewer-1' };
    excludedAuthorIds = new Set();

    expect(await getTrendingPostIds()).toEqual(['post-a', 'post-c', 'post-b']);
  });
});
