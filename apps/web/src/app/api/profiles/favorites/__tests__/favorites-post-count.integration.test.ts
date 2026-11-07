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
 * The request is authenticated with the non-production x-dev-user-id
 * header. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, favorites, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type FavoritesResponse = {
  profiles: Array<{ id: string; postCount: number; favoriteCount: number }>;
  total: number;
};

let viewerId: string;
let authorId: string;
const allPostIds: string[] = [];

let GET: typeof import('../route').GET;

async function fetchFavorites() {
  const request = new NextRequest(
    new Request('http://localhost/api/profiles/favorites'),
    { headers: { 'x-dev-user-id': viewerId } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FavoritesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../route'));

  [viewerId, authorId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `test-f7-viewer-${viewerId}`,
      displayName: 'Favorites Fixture Viewer',
      updatedAt: now,
    },
    {
      id: authorId,
      username: `test-f7-author-${authorId}`,
      displayName: 'Favorites Fixture Author',
      updatedAt: now,
    },
  ]);

  await db.insert(favorites).values({
    id: await generateSnowflakeId(),
    userId: viewerId,
    targetUserId: authorId,
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
  await db
    .delete(favorites)
    .where(
      and(eq(favorites.userId, viewerId), eq(favorites.targetUserId, authorId))
    );
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(inArray(users.id, [viewerId, authorId]));
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
