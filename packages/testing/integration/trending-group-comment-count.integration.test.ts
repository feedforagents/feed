/** Grouped trending comments under PRD §§6.1/12 and MVP Phase 5. */
import { beforeAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = [
  {
    signed: false,
    counts: 'public grouped trending counts only visible comments',
    update: 'public grouped trending reflects a moderation change',
  },
  {
    signed: true,
    counts: 'signed grouped trending counts only visible comments',
    update: 'signed grouped trending reflects a moderation change',
  },
] as const;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks grouped trending counts in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'trending-group-comment-count',
      file: 'packages/testing/integration/trending-group-comment-count.integration.test.ts',
      cases: cases.flatMap(({ counts, update }) => [counts, update]),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { optionalAuth } = await import('@feed/api');
  const { comments, db, eq, posts, postTags, tags, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET } = await import(
    '../../../apps/web/src/app/api/trending/group/route'
  );

  const [authorId, commenterId, tagAId, tagBId, mixedId, visibleId, deletedId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const tagA = `f5-alpha-${authorId}`;
  const tagB = `f5-beta-${authorId}`;
  const stewardClaim = `steward-f5-${commenterId}`;
  const token = await createStewardTestToken(stewardClaim);
  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const mixedVisibleCommentId = await generateSnowflakeId();

  beforeAll(async () => {
    await db.transaction(async (tx) => {
      await tx.insert(users).values([
        {
          id: authorId,
          username: `test-f5-${authorId}`,
          displayName: 'Trending Comment Count Author',
          updatedAt: now,
        },
        {
          id: commenterId,
          username: `test-f5-c-${commenterId}`,
          displayName: 'Trending Comment Count Commenter',
          stewardId: stewardClaim,
          updatedAt: now,
        },
      ]);
      await tx.insert(tags).values(
        [
          { id: tagAId, name: tagA, displayName: 'F5 Alpha' },
          { id: tagBId, name: tagB, displayName: 'F5 Beta' },
        ].map((tag) => ({
          ...tag,
          category: 'test',
          createdAt: past,
          updatedAt: past,
        }))
      );
      await tx.insert(posts).values(
        [
          { id: mixedId, content: 'mixed moderation trending post' },
          { id: visibleId, content: 'fully visible trending post' },
          { id: deletedId, content: 'moderated-only trending post' },
        ].map((post) => ({
          ...post,
          authorId,
          timestamp: past,
          createdAt: past,
        }))
      );
      const commentSpecs = [
        { postId: mixedId, visible: 2, deleted: 2 },
        { postId: visibleId, visible: 3, deleted: 0 },
        { postId: deletedId, visible: 0, deleted: 2 },
      ];
      for (const { postId, visible, deleted } of commentSpecs) {
        for (let index = 0; index < visible + deleted; index++) {
          await tx.insert(comments).values({
            id:
              postId === mixedId && index === 0
                ? mixedVisibleCommentId
                : await generateSnowflakeId(),
            content: 'Trending comment count fixture',
            postId,
            authorId: commenterId,
            createdAt: past,
            updatedAt: past,
            deletedAt: index < visible ? null : past,
          });
        }
      }
      await tx.insert(postTags).values([
        {
          id: await generateSnowflakeId(),
          postId: mixedId,
          tagId: tagAId,
          createdAt: past,
        },
        {
          id: await generateSnowflakeId(),
          postId: visibleId,
          tagId: tagBId,
          createdAt: past,
        },
        {
          id: await generateSnowflakeId(),
          postId: deletedId,
          tagId: tagAId,
          createdAt: past,
        },
      ]);
    });
  });

  async function fetchCounts(signed: boolean) {
    const url = new URL('http://localhost/api/trending/group');
    url.searchParams.set('tags', `${tagA},${tagB}`);
    url.searchParams.set('limit', '10');
    const requestId = crypto.randomUUID();
    const request = new NextRequest(url, {
      headers: {
        'x-request-id': requestId,
        ...(signed ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (signed) {
      const viewer = await optionalAuth(request);
      expect(viewer?.userId).toBe(commenterId);
    }
    const response = await GET(request);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      success: boolean;
      posts: { id: string; commentCount: number }[];
    };
    expect(result.success).toBe(true);
    const counts = new Map(
      result.posts.map(({ id, commentCount }) => [id, commentCount])
    );
    console.info('Grouped trending comment counts', {
      requestId,
      status: response.status,
      signed,
      mixed: counts.get(mixedId),
      visible: counts.get(visibleId),
      deleted: counts.get(deletedId),
    });
    return counts;
  }

  for (const { signed, counts, update } of cases) {
    test(counts, async () => {
      const totals = await fetchCounts(signed);
      expect(totals.get(mixedId)).toBe(2);
      expect(totals.get(visibleId)).toBe(3);
      expect(totals.get(deletedId)).toBe(0);
    });

    test(update, async () => {
      try {
        await db
          .update(comments)
          .set({ deletedAt: new Date() })
          .where(eq(comments.id, mixedVisibleCommentId));
        expect((await fetchCounts(signed)).get(mixedId)).toBe(1);
      } finally {
        await db
          .update(comments)
          .set({ deletedAt: null })
          .where(eq(comments.id, mixedVisibleCommentId));
      }
      expect((await fetchCounts(signed)).get(mixedId)).toBe(2);
    });
  }
}
