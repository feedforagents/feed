/**
 * Existing favorites reads follow the retained moderation/publication rules
 * (PRD §12, MVP phase 5). A2A and favorites remain outside the future MCP
 * scope (PRD §8.2, MVP phase 1); no new capability is introduced here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import {
  db,
  favorites,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

type FavoritePost = {
  id: string;
  content: string;
  authorId: string;
  timestamp: string;
};

const ids = new Map<string, string>();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  favorites: [] as string[],
  blocks: [] as string[],
  mutes: [] as string[],
};

function id(label: string): string {
  const value = ids.get(label);
  if (!value) throw new Error(`Missing owned fixture: ${label}`);
  return value;
}

async function readFavorites(
  viewer = id('viewer'),
  params: Record<string, JsonValue> = { limit: 50 }
): Promise<FavoritePost[]> {
  const result = (await FeedAgentExecutor.executeDirectly(
    'favorites.posts',
    params,
    viewer
  )) as { posts: FavoritePost[] };
  return result.posts;
}

beforeAll(async () => {
  const labels = [
    'viewer',
    'empty-viewer',
    'hidden-viewer',
    'normal',
    'scheduled',
    'muted',
    'blocked',
    'blocking',
    'unfavorited',
  ];
  for (const label of labels) ids.set(label, await generateSnowflakeId());
  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values(
      labels.map((label) => ({
        id: id(label),
        username: `a2a-favorites-${id(label)}`,
        displayName: `Favorites fixture ${label}`,
        reputationPoints: 0,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });
  owned.users.push(...insertedUsers.map((row) => row.id));

  const authorLabels = ['normal', 'scheduled', 'muted', 'blocked', 'blocking'];
  const insertedFavorites = await db
    .insert(favorites)
    .values([
      ...authorLabels.map((label) => ({
        id: `fav-${id('viewer')}-${id(label)}`,
        userId: id('viewer'),
        targetUserId: id(label),
      })),
      {
        id: `fav-${id('hidden-viewer')}-${id('blocked')}`,
        userId: id('hidden-viewer'),
        targetUserId: id('blocked'),
      },
    ])
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
      {
        id: `block-${id('hidden-viewer')}`,
        blockerId: id('hidden-viewer'),
        blockedId: id('blocked'),
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
    { label: 'visible-newest', author: 'scheduled', ageMinutes: 120 },
    { label: 'visible-middle', author: 'normal', ageMinutes: 180 },
    { label: 'visible-oldest', author: 'normal', ageMinutes: 240 },
    { label: 'future', author: 'scheduled', ageMinutes: -120 },
    { label: 'muted-post', author: 'muted', ageMinutes: 10 },
    { label: 'blocked-post', author: 'blocked', ageMinutes: 20 },
    { label: 'blocking-post', author: 'blocking', ageMinutes: 30 },
    { label: 'deleted-post', author: 'normal', ageMinutes: 40 },
    { label: 'article', author: 'normal', ageMinutes: 50 },
    { label: 'unfavorited-post', author: 'unfavorited', ageMinutes: 5 },
  ];
  for (const definition of definitions) {
    ids.set(definition.label, await generateSnowflakeId());
  }
  const insertedPosts = await db
    .insert(posts)
    .values(
      definitions.map(({ label, author, ageMinutes }) => ({
        id: id(label),
        authorId: id(author),
        content: `Favorites fixture ${label}`,
        timestamp: new Date(now.getTime() - ageMinutes * 60_000),
        type: label === 'article' ? 'article' : 'post',
        articleTitle: label === 'article' ? 'Owned article control' : null,
        deletedAt: label === 'deleted-post' ? now : null,
      }))
    )
    .returning({ id: posts.id });
  owned.posts.push(...insertedPosts.map((row) => row.id));
});

afterAll(async () => {
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

describe('A2A favorites post visibility before limiting', () => {
  it('keeps published posts from an author who also has a future post', async () => {
    const result = await readFavorites();
    expect(result.map((post) => post.id)).toContain(id('visible-newest'));
    expect(result.map((post) => post.id)).not.toContain(id('future'));
  });

  it('excludes moderated, deleted, non-post, and unfavorited controls', async () => {
    const result = await readFavorites();
    expect(result.map((post) => post.id)).toEqual([
      id('visible-newest'),
      id('visible-middle'),
      id('visible-oldest'),
    ]);
    for (const post of result) {
      expect(Object.keys(post).sort()).toEqual([
        'authorId',
        'content',
        'id',
        'timestamp',
      ]);
      expect(Number.isFinite(Date.parse(post.timestamp))).toBe(true);
    }
  });

  it('fills small limits from eligible posts despite newer excluded posts', async () => {
    for (const [limit, expected] of [
      [1, ['visible-newest']],
      [2, ['visible-newest', 'visible-middle']],
      ['2', ['visible-newest', 'visible-middle']],
    ] as const) {
      const result = await readFavorites(id('viewer'), { limit });
      expect(result.map((post) => post.id)).toEqual(expected.map(id));
    }
  });

  it('returns an empty collection for an account without favorites', async () => {
    expect(await readFavorites(id('empty-viewer'))).toEqual([]);
  });

  it('returns an empty collection when every favorited author is excluded', async () => {
    expect(await readFavorites(id('hidden-viewer'))).toEqual([]);
  });
});
