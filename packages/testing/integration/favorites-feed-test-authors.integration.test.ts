/**
 * Existing favorites reads retain social visibility and moderation rules
 * (PRD §12, MVP phase 5). Favorites are not a new MCP capability (§8.2).
 * Uses real HTTP, PostgreSQL and locally signed test JWTs; no route stubs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  comments,
  db,
  favorites,
  inArray,
  posts,
  reactions,
  shares,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { actors } from '../../pack-default/src/actors-index';

type FeedPost = {
  id: string;
  authorId: string;
  interactions: {
    likeCount: number;
    commentCount: number;
    shareCount: number;
    isLiked: boolean;
    isShared: boolean;
  };
};
type FeedBody = {
  posts: FeedPost[];
  total: number;
  hasMore: boolean;
  limit?: number;
  offset?: number;
};

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const ids = new Map<string, string>();
const tokens = new Map<string, string>();
const owned = {
  users: [] as string[],
  favorites: [] as string[],
  blocks: [] as string[],
  mutes: [] as string[],
  posts: [] as string[],
  reactions: [] as string[],
  comments: [] as string[],
  shares: [] as string[],
};

function id(label: string): string {
  const value = ids.get(label);
  if (!value) throw new Error(`Missing owned fixture ${label}`);
  return value;
}

function auth(viewer = 'viewer', cookie = false): Record<string, string> {
  const token = tokens.get(viewer);
  if (!token) throw new Error(`Missing signed fixture token ${viewer}`);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}

async function readFeed(
  query = 'limit=20&page=1',
  headers: Record<string, string> = auth()
) {
  const response = await fetch(`${baseUrl}/api/posts/feed/favorites?${query}`, {
    headers,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as FeedBody;
  expect(Array.isArray(body.posts)).toBe(true);
  expect(Number.isInteger(body.total)).toBe(true);
  expect(typeof body.hasMore).toBe('boolean');
  return { response, body };
}

beforeAll(async () => {
  const secret = process.env.STEWARD_JWT_SECRET;
  if (!secret) throw new Error('STEWARD_JWT_SECRET is required for HTTP tests');
  const labels = [
    'viewer',
    'other-viewer',
    'empty-viewer',
    'hidden-viewer',
    'normal',
    'flagged',
    'prefixed',
    'muted',
    'blocked',
    'blocking',
    'other-author',
  ];
  for (const label of labels) {
    const generated = await generateSnowflakeId();
    ids.set(
      label,
      label === 'prefixed' ? `test-pr1670-${generated}` : generated
    );
  }
  // Select an unused real registry author without mutating canonical data.
  // Existing NPC posts must not contaminate this run's exact page/count fixture.
  const registryIds = actors.map((actor) => actor.id);
  const registryUsers = await db
    .select({ id: users.id, isTest: users.isTest })
    .from(users)
    .where(inArray(users.id, registryIds));
  const registryAuthorsWithPosts = await db
    .select({ authorId: posts.authorId })
    .from(posts)
    .where(inArray(posts.authorId, registryIds))
    .groupBy(posts.authorId);
  const occupied = new Set(registryAuthorsWithPosts.map((row) => row.authorId));
  const userById = new Map(registryUsers.map((row) => [row.id, row]));
  const available = actors.filter(
    (actor) =>
      !occupied.has(actor.id) &&
      !userById.get(actor.id)?.isTest &&
      !actor.id.startsWith('test-')
  );
  const actor =
    available.find((actor) => !userById.has(actor.id)) ?? available[0];
  if (!actor)
    throw new Error(
      'Disposable fixture database needs one unused non-test registry actor'
    );
  ids.set('actor', actor.id);
  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values(
      labels.map((label) => ({
        id: id(label),
        username: `favorite-feed-${id(label)}`,
        displayName: `Favorites fixture ${label}`,
        isTest: label === 'flagged',
        stewardId: label.endsWith('viewer') ? `pr1670-${id(label)}` : null,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });
  owned.users.push(...insertedUsers.map((row) => row.id));
  for (const viewer of [
    'viewer',
    'other-viewer',
    'empty-viewer',
    'hidden-viewer',
  ]) {
    tokens.set(
      viewer,
      await new SignJWT({ userId: `pr1670-${id(viewer)}` })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('steward')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode(secret))
    );
  }

  const favoriteRows = [
    ...[
      'normal',
      'actor',
      'flagged',
      'prefixed',
      'muted',
      'blocked',
      'blocking',
    ].map((author) => ({
      id: `fav-${id('viewer')}-${id(author)}`,
      userId: id('viewer'),
      targetUserId: id(author),
    })),
    ...['flagged', 'prefixed'].map((author) => ({
      id: `fav-${id('hidden-viewer')}-${id(author)}`,
      userId: id('hidden-viewer'),
      targetUserId: id(author),
    })),
    {
      id: `fav-${id('other-viewer')}-${id('other-author')}`,
      userId: id('other-viewer'),
      targetUserId: id('other-author'),
    },
  ];
  const insertedFavorites = await db
    .insert(favorites)
    .values(favoriteRows)
    .returning({ id: favorites.id });
  owned.favorites.push(...insertedFavorites.map((row) => row.id));
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      {
        id: `block-${id('viewer')}`,
        blockerId: id('viewer'),
        blockedId: id('blocked'),
      },
      {
        id: `blockby-${id('viewer')}`,
        blockerId: id('blocking'),
        blockedId: id('viewer'),
      },
    ])
    .returning({ id: userBlocks.id });
  owned.blocks.push(...insertedBlocks.map((row) => row.id));
  const insertedMutes = await db
    .insert(userMutes)
    .values({
      id: `mute-${id('viewer')}`,
      muterId: id('viewer'),
      mutedId: id('muted'),
    })
    .returning({ id: userMutes.id });
  owned.mutes.push(...insertedMutes.map((row) => row.id));

  const definitions = [
    { label: 'normal-newest', author: 'normal', age: 120 },
    { label: 'actor-post', author: 'actor', age: 180 },
    { label: 'normal-oldest', author: 'normal', age: 240 },
    { label: 'flagged-post', author: 'flagged', age: 10 },
    { label: 'prefixed-post', author: 'prefixed', age: 20 },
    { label: 'muted-post', author: 'muted', age: 30 },
    { label: 'blocked-post', author: 'blocked', age: 40 },
    { label: 'blocking-post', author: 'blocking', age: 50 },
    { label: 'future', author: 'normal', age: -120 },
    { label: 'deleted', author: 'normal', age: 15 },
    { label: 'other-post', author: 'other-author', age: 5 },
  ];
  for (const definition of definitions)
    ids.set(definition.label, await generateSnowflakeId());
  const insertedPosts = await db
    .insert(posts)
    .values(
      definitions.map(({ label, author, age }) => ({
        id: id(label),
        authorId: id(author),
        content: `Favorites feed fixture ${label}`,
        timestamp: new Date(now.getTime() - age * 60_000),
        createdAt: new Date(now.getTime() - age * 60_000),
        deletedAt: label === 'deleted' ? now : null,
      }))
    )
    .returning({ id: posts.id });
  owned.posts.push(...insertedPosts.map((row) => row.id));
  const insertedReactions = await db
    .insert(reactions)
    .values(
      ['viewer', 'other-viewer'].map((viewer) => ({
        id: `like-${id(viewer)}-${id('normal-newest')}`,
        userId: id(viewer),
        postId: id('normal-newest'),
        type: 'like',
      }))
    )
    .returning({ id: reactions.id });
  owned.reactions.push(...insertedReactions.map((row) => row.id));
  const insertedComments = await db
    .insert(comments)
    .values(
      [0, 1, 2].map((index) => ({
        id: `comment-${id('normal-newest')}-${index}`,
        postId: id('normal-newest'),
        authorId: id('normal'),
        content: 'Owned favorites comment',
        updatedAt: now,
        deletedAt: index === 2 ? now : null,
      }))
    )
    .returning({ id: comments.id });
  owned.comments.push(...insertedComments.map((row) => row.id));
  const insertedShares = await db
    .insert(shares)
    .values({
      id: `share-${id('viewer')}-${id('normal-newest')}`,
      userId: id('viewer'),
      postId: id('normal-newest'),
    })
    .returning({ id: shares.id });
  owned.shares.push(...insertedShares.map((row) => row.id));
});

afterAll(async () => {
  if (owned.reactions.length)
    await db.delete(reactions).where(inArray(reactions.id, owned.reactions));
  if (owned.comments.length)
    await db.delete(comments).where(inArray(comments.id, owned.comments));
  if (owned.shares.length)
    await db.delete(shares).where(inArray(shares.id, owned.shares));
  if (owned.posts.length)
    await db.delete(posts).where(inArray(posts.id, owned.posts));
  if (owned.favorites.length)
    await db.delete(favorites).where(inArray(favorites.id, owned.favorites));
  if (owned.blocks.length)
    await db.delete(userBlocks).where(inArray(userBlocks.id, owned.blocks));
  if (owned.mutes.length)
    await db.delete(userMutes).where(inArray(userMutes.id, owned.mutes));
  if (owned.users.length)
    await db.delete(users).where(inArray(users.id, owned.users));
});

describe('favorites feed excludes test authors before pages and totals', () => {
  it('retains normal and real NPC posts while excluding hidden authors and posts', async () => {
    const { body, response } = await readFeed();
    expect(body.posts.map((post) => post.id)).toEqual([
      id('normal-newest'),
      id('actor-post'),
      id('normal-oldest'),
    ]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('fills limit-one pages and keeps the filtered total through the empty tail', async () => {
    const expected = [
      id('normal-newest'),
      id('actor-post'),
      id('normal-oldest'),
    ];
    for (let page = 1; page <= 4; page++) {
      const { body } = await readFeed(`limit=1&page=${page}`);
      expect(body.posts.map((post) => post.id)).toEqual(
        expected.slice(page - 1, page)
      );
      expect(body.total).toBe(3);
      expect(body.hasMore).toBe(page < 3);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(page - 1);
    }
  });

  it('preserves interaction counts and the viewer state', async () => {
    const { body } = await readFeed();
    const normal = body.posts.find((post) => post.id === id('normal-newest'));
    expect(normal?.interactions).toEqual({
      likeCount: 2,
      commentCount: 2,
      shareCount: 1,
      isLiked: true,
      isShared: true,
    });
    const npc = body.posts.find((post) => post.id === id('actor-post'));
    expect(npc?.interactions).toEqual({
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      isLiked: false,
      isShared: false,
    });
  });

  it('accepts the same viewer through the normal token cookie', async () => {
    const { body } = await readFeed('limit=1&page=1', auth('viewer', true));
    expect(body.posts.map((post) => post.id)).toEqual([id('normal-newest')]);
    expect(body.total).toBe(3);
  });

  it('returns empty totals for all-test and no-favorite accounts', async () => {
    for (const viewer of ['hidden-viewer', 'empty-viewer']) {
      const { body } = await readFeed('limit=1&page=1', auth(viewer));
      expect(body.posts).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.hasMore).toBe(false);
    }
  });

  it('binds favorites to the authenticated owner rather than a query parameter', async () => {
    const other = await readFeed('limit=20&page=1', auth('other-viewer'));
    expect(other.body.posts.map((post) => post.id)).toEqual([id('other-post')]);
    expect(other.body.total).toBe(1);
    const viewer = await readFeed(
      `limit=20&page=1&userId=${id('other-viewer')}`
    );
    expect(viewer.body.posts.map((post) => post.id)).toEqual([
      id('normal-newest'),
      id('actor-post'),
      id('normal-oldest'),
    ]);
    expect(viewer.body.total).toBe(3);
  });

  it('preserves the empty optional-auth response for missing or invalid tokens', async () => {
    const unauthenticatedHeaders: Record<string, string>[] = [
      {},
      { authorization: 'Bearer invalid.invalid.invalid' },
    ];
    for (const headers of unauthenticatedHeaders) {
      const { body } = await readFeed('limit=1&page=1', headers);
      expect(body.posts).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.hasMore).toBe(false);
    }
  });
});
