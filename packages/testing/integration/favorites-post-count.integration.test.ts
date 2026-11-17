/**
 * GET /api/profiles/favorites against a real database: the postCount shown
 * next to a favorited profile must count only posts a viewer can actually
 * see — not soft-deleted posts and not future-dated (not yet published)
 * posts.
 *
 * The actor stats route states the rule for the same quantity ("Visible
 * posts by this actor: not deleted and already published (future-scheduled
 * posts must not be counted or hinted at)"), the author's own posts tab
 * excludes future posts, and the time-filtering suite states the rule for
 * the whole API: "APIs should not expose future posts or events." The
 * favorites list counted every post row for the author, so a favorited
 * profile's count included moderated-away posts and unpublished scheduled
 * posts that appear nowhere else.
 *
 * The request is authenticated with the existing CI synthetic bearer. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, favorites, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type FavoritesResponse = {
  profiles: Array<{ id: string; postCount: number; favoriteCount: number }>;
  total: number;
};

let viewerId: string;
let authorId: string;
let emptyAuthorId: string;
const allPostIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/profiles/favorites/route').GET;

async function fetchFavorites() {
  const request = new NextRequest(
    new Request('http://localhost/api/profiles/favorites'),
    { headers: { authorization: `Bearer steward:test:${viewerId}` } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FavoritesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/profiles/favorites/route'
  ));

  [viewerId, authorId, emptyAuthorId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f7v-${viewerId}`,
      displayName: 'Favorites Fixture Viewer',
      updatedAt: now,
    },
    {
      id: authorId,
      username: `f7a-${authorId}`,
      displayName: 'Favorites Fixture Author',
      updatedAt: now,
    },
    {
      id: emptyAuthorId,
      username: `f7e-${emptyAuthorId}`,
      displayName: 'Empty fixture author',
      updatedAt: now,
    },
  ]);

  await db.insert(favorites).values({
    id: await generateSnowflakeId(),
    userId: viewerId,
    targetUserId: authorId,
    createdAt: now,
  });

  await db.insert(favorites).values({
    id: await generateSnowflakeId(),
    userId: viewerId,
    targetUserId: emptyAuthorId,
    createdAt: now,
  });

  // Two posts anyone can see, one soft-deleted post, and one post whose
  // timestamp is two hours in the future (not yet published anywhere).
  const postIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  allPostIds.push(...postIds);
  await db.insert(posts).values([
    {
      id: postIds[0]!,
      content: 'visible post one',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: postIds[1]!,
      content: 'visible post two',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: postIds[2]!,
      content: 'soft-deleted post',
      authorId,
      timestamp: past,
      createdAt: past,
      deletedAt: past,
    },
    {
      id: postIds[3]!,
      content: 'future post that must not be hinted at',
      authorId,
      timestamp: future,
      createdAt: past,
    },
  ]);
});

afterAll(async () => {
  await db.delete(favorites).where(eq(favorites.userId, viewerId));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db
    .delete(users)
    .where(inArray(users.id, [viewerId, authorId, emptyAuthorId]));
});

describe('GET /api/profiles/favorites postCount', () => {
  it('counts only the author posts a viewer can see', async () => {
    const { status, body } = await fetchFavorites();
    expect(status).toBe(200);
    const list = body as FavoritesResponse;
    const entry = list.profiles.find((p) => p.id === authorId);
    expect(entry).toBeDefined();
    // 2 visible posts; the soft-deleted and future-dated posts must not
    // be counted (staging counts all 4).
    expect(entry!.postCount).toBe(2);
    expect(entry!.favoriteCount).toBe(1);
  });
});

describe('favorite counts track publication and moderation', () => {
  it('returns zero for a favorited author without posts', async () => {
    const { status, body } = await fetchFavorites();
    expect(status).toBe(200);
    const list = body as FavoritesResponse;
    expect(list.total).toBe(2);
    expect(list.profiles.find((p) => p.id === emptyAuthorId)?.postCount).toBe(
      0
    );
  });

  it('counts a future post once its owned timestamp becomes eligible', async () => {
    const postId = allPostIds[3]!;
    const [original] = await db
      .select({ timestamp: posts.timestamp })
      .from(posts)
      .where(eq(posts.id, postId));
    try {
      await db
        .update(posts)
        .set({ timestamp: new Date(Date.now() - 1000) })
        .where(eq(posts.id, postId));
      const { status, body } = await fetchFavorites();
      expect(status).toBe(200);
      expect(
        (body as FavoritesResponse).profiles.find((p) => p.id === authorId)
          ?.postCount
      ).toBe(3);
    } finally {
      await db
        .update(posts)
        .set({ timestamp: original!.timestamp })
        .where(eq(posts.id, postId));
    }
  });

  it('removes an owned post from the count when soft-deleted', async () => {
    const postId = allPostIds[0]!;
    try {
      await db
        .update(posts)
        .set({ deletedAt: new Date() })
        .where(eq(posts.id, postId));
      const { status, body } = await fetchFavorites();
      expect(status).toBe(200);
      expect(
        (body as FavoritesResponse).profiles.find((p) => p.id === authorId)
          ?.postCount
      ).toBe(1);
    } finally {
      await db
        .update(posts)
        .set({ deletedAt: null })
        .where(eq(posts.id, postId));
    }
  });
});
