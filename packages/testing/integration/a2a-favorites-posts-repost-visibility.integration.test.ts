/**
 * A2A favorites posts hide simple reposts of excluded or deleted originals
 *
 * (PRD §12, MVP phase 5). A simple repost is only its original, so when the
 * viewer blocked or muted the original author (or the original author
 * blocked the viewer), the repost must not appear in the viewer's favorites
 * feed — the same rule the web favorites feed applies in SQL before the page
 * is cut (postFeedVisibilityConditions, excludeModeratedReposts). Quotes keep
 * their row: the viewer wrote their own commentary, so only the original is
 * hidden. A simple repost of a soft-deleted original is excluded too
 * (excludeDeadReposts), matching the web feed. Filtering happens in SQL
 * before LIMIT, so small limits still fill from eligible posts instead of
 * stranding on a newer forbidden repost.
 *
 * A2A and favorites remain outside the future MCP scope (PRD §8.2, MVP
 * phase 1); no new capability is introduced here.
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
    'owner',
    'normal',
    'blocked',
    'muted',
    'blocking',
  ];

  for (const label of labels) ids.set(label, await generateSnowflakeId());

  const now = new Date();

  const insertedUsers = await db
    .insert(users)
    .values(
      labels.map((label) => ({
        id: id(label),
        username: `a2a-fav-repost-${id(label)}`,
        displayName: `Favorites repost fixture ${label}`,
        reputationPoints: 0,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });

  owned.users.push(...insertedUsers.map((row) => row.id));

  const insertedFavorites = await db
    .insert(favorites)
    .values([
      {
        id: `fav-${id('viewer')}-${id('owner')}`,
        userId: id('viewer'),
        targetUserId: id('owner'),
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

  const originals = [
    { label: 'normal-original', author: 'normal' },
    { label: 'blocked-original', author: 'blocked' },
    { label: 'muted-original', author: 'muted' },
    { label: 'blocking-original', author: 'blocking' },
    { label: 'dead-original', author: 'normal', deleted: true },
  ];

  for (const original of originals) {
    ids.set(original.label, await generateSnowflakeId());
  }

  const older = new Date(now.getTime() - 3_600_000);

  const insertedOriginals = await db
    .insert(posts)
    .values(
      originals.map(({ label, author, deleted }, index) => ({
        id: id(label),
        authorId: id(author),
        content: `Favorites repost fixture ${label}`,
        timestamp: new Date(older.getTime() - index * 1000),
        type: 'post',
        deletedAt: deleted ? now : null,
      }))
    )
    .returning({ id: posts.id });

  owned.posts.push(...insertedOriginals.map((row) => row.id));

  const ownerPosts = [
    {
      label: 'blocked-repost',
      content: '',
      originalPostId: 'blocked-original',
      ageSeconds: 10,
    },
    {
      label: 'visible-post',
      content: 'Visible post',
      originalPostId: null,
      ageSeconds: 20,
    },
    {
      label: 'blocked-quote',
      content: 'Visible quote commentary',
      originalPostId: 'blocked-original',
      ageSeconds: 30,
    },
    {
      label: 'normal-repost',
      content: '',
      originalPostId: 'normal-original',
      ageSeconds: 40,
    },
    {
      label: 'muted-repost',
      content: '',
      originalPostId: 'muted-original',
      ageSeconds: 50,
    },
    {
      label: 'blocking-repost',
      content: '',
      originalPostId: 'blocking-original',
      ageSeconds: 60,
    },
    {
      label: 'dead-repost',
      content: '',
      originalPostId: 'dead-original',
      ageSeconds: 70,
    },
  ];

  for (const post of ownerPosts) {
    ids.set(post.label, await generateSnowflakeId());
  }

  const insertedOwnerPosts = await db
    .insert(posts)
    .values(
      ownerPosts.map(({ label, content, originalPostId, ageSeconds }) => ({
        id: id(label),
        authorId: id('owner'),
        content,
        originalPostId: originalPostId ? id(originalPostId) : null,
        timestamp: new Date(now.getTime() - ageSeconds * 1000),
        type: 'post',
      }))
    )
    .returning({ id: posts.id });

  owned.posts.push(...insertedOwnerPosts.map((row) => row.id));
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

describe('A2A favorites posts hide reposts of excluded originals', () => {
  it('hides simple reposts of excluded and deleted originals but keeps quotes and visible reposts', async () => {
    const result = await readFavorites();

    expect(result.map((post) => post.id)).toEqual([
      id('visible-post'),
      id('blocked-quote'),
      id('normal-repost'),
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

  it('fills small limits from eligible posts despite a newer forbidden repost', async () => {
    for (const [limit, expected] of [
      [1, ['visible-post']],
      [2, ['visible-post', 'blocked-quote']],
    ] as const) {
      const result = await readFavorites(id('viewer'), { limit });

      expect(result.map((post) => post.id)).toEqual(expected.map(id));
    }
  });
});
