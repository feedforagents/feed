/**
 * PRD §9.2 / MVP Phase 6: a post the user just published must show up on
 * their own profile. The profile page loads its posts through
 * `GET /api/posts?actorId=<id>`, which reads `cachedDb.getPostsByActor`.
 * `POST /api/posts` calls `cachedDb.invalidateActorPostsCache(authorId)`
 * right after the insert, so the next profile read must be fresh.
 *
 * Repro: prime the actor cache with post A, insert post B (timestamp
 * `new Date()`, exactly as POST inserts it — the read path excludes
 * future-dated rows, so a future stamp would hide the post for a
 * different reason), run exactly the invalidations POST performs, then
 * read the actor feed again. On base the second read still returns only
 * A (stale for the 180s actor TTL): the invalidation pattern
 * `${authorId}:*` never matches the key `getPostsByActor` actually
 * writes, which is the JSON `["post-visibility-v1", authorId, ...]`
 * form produced whenever a visibility object is passed — and the GET
 * route always passes one. The recent-posts list and the following feed
 * do not have this problem: `invalidatePostsCache` clears their whole
 * namespaces with `*`, so the same new post appears in the main feed
 * and in a follower's feed immediately while missing from the profile.
 * That divergence is the control assertions below.
 */
import { describe, expect, test } from 'bun:test';
import { cachedDb } from '@feed/api';
import { db, eq, type PostFeedVisibilityOptions, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

// The visibility object GET /api/posts always builds for the viewer (here a
// viewer with no blocked/muted/blocking authors, so the exclusion list is
// empty — the key is still the JSON form, never the `${authorId}:` prefix).
const VISIBILITY: PostFeedVisibilityOptions = {
  excludedAuthorIds: [],
  excludeDeadReposts: true,
};

describe('actor posts cache invalidation after publish', () => {
  test('a newly published post appears on the author profile after invalidation', async () => {
    const authorId = await generateSnowflakeId();
    const username = `actorcache_${authorId.slice(-10)}`;
    await db.insert(users).values({
      id: authorId,
      username,
      updatedAt: new Date(),
    });
    const postAId = await generateSnowflakeId();
    const postBId = await generateSnowflakeId();
    try {
      await db.insert(posts).values({
        id: postAId,
        content: `actor cache probe A ${postAId}`,
        authorId,
        timestamp: new Date(),
      });

      // Prime every read path exactly as the UI does, before the publish.
      const firstRead = await cachedDb.getPostsByActor(
        authorId,
        100,
        undefined,
        VISIBILITY
      );
      expect(firstRead.map((p) => p.id)).toContain(postAId);
      const followerId = await generateSnowflakeId();
      const followingBefore = await cachedDb.getPostsForFollowing(
        followerId,
        [authorId],
        100
      );
      expect(followingBefore.map((p) => p.id)).toContain(postAId);
      const recentBefore = await cachedDb.getRecentPosts(
        100,
        undefined,
        VISIBILITY
      );
      expect(recentBefore.map((p) => p.id)).toContain(postAId);

      // The user publishes a second post (direct insert = the row POST
      // /api/posts has just committed), then POST runs exactly these two
      // invalidations.
      await db.insert(posts).values({
        id: postBId,
        content: `actor cache probe B ${postBId}`,
        authorId,
        timestamp: new Date(),
      });
      await cachedDb.invalidateActorPostsCache(authorId);
      await cachedDb.invalidatePostsCache();

      // The profile must now show the new post.
      const secondRead = await cachedDb.getPostsByActor(
        authorId,
        100,
        undefined,
        VISIBILITY
      );
      expect(secondRead.map((p) => p.id)).toContain(postBId);

      // Controls: the main (recent) feed and a follower's following feed
      // invalidate correctly, so the same post is visible there — the
      // staleness is actor-list specific. (`invalidatePostsCache` clears
      // both namespaces with `*`.)
      const recent = await cachedDb.getRecentPosts(100, undefined, VISIBILITY);
      expect(recent.map((p) => p.id)).toContain(postBId);
      const followingAfter = await cachedDb.getPostsForFollowing(
        followerId,
        [authorId],
        100
      );
      expect(followingAfter.map((p) => p.id)).toContain(postBId);
    } finally {
      await db.delete(posts).where(eq(posts.authorId, authorId));
      await db.delete(users).where(eq(users.id, authorId));
      await cachedDb.invalidateActorPostsCache(authorId);
      await cachedDb.invalidatePostsCache();
    }
  });
});
