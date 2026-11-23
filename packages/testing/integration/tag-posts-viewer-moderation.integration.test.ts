/**
 * PRD section 12 (hashtags/trending and block/mute are kept), MVP Phase 5:
 * the tag post lists honor the viewer's blocks and mutes before paging, on
 * the web tag page, the grouped tag page and A2A stats.posts_by_tag.
 */
import { describe, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'tag post lists viewer moderation';
const cases = {
  web: 'applies blocks and mutes before the web tag page and its total',
  group: 'applies blocks and mutes before the grouped tag window',
  a2a: 'applies blocks and mutes before A2A tag paging',
  others: 'keeps every post for anonymous and unrelated viewers',
  cache: 'keeps signed-in tag responses out of shared caches',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks tag post moderation in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'tag-posts-viewer-moderation',
      file: 'packages/testing/integration/tag-posts-viewer-moderation.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();

  const { FeedAgentExecutor } = await import('@feed/a2a');
  const { optionalAuth } = await import('@feed/api');
  const { dbWrite, posts, postTags, tags, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { NextRequest } = await import('next/server');
  const { GET: tagPage } = await import(
    '../../../apps/web/src/app/api/trending/[tag]/route'
  );
  const { GET: groupPage } = await import(
    '../../../apps/web/src/app/api/trending/group/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const TAG = 'moderationtag';
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  const { generateSnowflakeId } = await import('@feed/shared');
  // Signed-in reads run under row-level security, which needs snowflake ids.
  const people = {
    viewer: await generateSnowflakeId(),
    stranger: await generateSnowflakeId(),
    normal: await generateSnowflakeId(),
    blocked: await generateSnowflakeId(),
    muted: await generateSnowflakeId(),
    blocker: await generateSnowflakeId(),
  };
  await dbWrite.insert(users).values(
    Object.values(people).map((id) => ({
      id,
      stewardId: `steward-${id}`,
      username: `tag-moderation-${id}`,
      updatedAt: new Date(now),
    }))
  );
  await dbWrite.insert(userBlocks).values([
    {
      id: 'tag-block-out',
      blockerId: people.viewer,
      blockedId: people.blocked,
    },
    { id: 'tag-block-in', blockerId: people.blocker, blockedId: people.viewer },
  ]);
  await dbWrite.insert(userMutes).values({
    id: 'tag-mute',
    muterId: people.viewer,
    mutedId: people.muted,
  });

  // Hidden authors hold the newest tagged posts, so on base they fill the
  // first page and the visible posts only appear after them. The newest row
  // is a plain repost (empty content) of the blocked author's post by a
  // visible author, which the feeds hide like the original.
  const fixture: Array<{
    id: string;
    authorId: string;
    minutesAgo: number;
    originalPostId?: string;
  }> = [
    {
      id: 'tag-repost-of-blocked',
      authorId: people.normal,
      minutesAgo: 0.5,
      originalPostId: 'tag-blocked-post',
    },
    { id: 'tag-blocked-post', authorId: people.blocked, minutesAgo: 1 },
    { id: 'tag-muted-post', authorId: people.muted, minutesAgo: 2 },
    { id: 'tag-blocker-post', authorId: people.blocker, minutesAgo: 3 },
    { id: 'tag-visible-new', authorId: people.normal, minutesAgo: 4 },
    { id: 'tag-visible-old', authorId: people.normal, minutesAgo: 5 },
  ];
  const allIds = fixture.map(({ id }) => id);
  const visibleIds = ['tag-visible-new', 'tag-visible-old'];
  await dbWrite.insert(tags).values({
    id: 'tag-moderation',
    name: TAG,
    displayName: 'Moderation Tag',
    updatedAt: new Date(now),
  });
  await dbWrite.insert(posts).values(
    fixture.map(({ id, authorId, minutesAgo, originalPostId }) => ({
      id,
      authorId,
      content: originalPostId ? '' : `#${TAG} ${id}`,
      originalPostId: originalPostId ?? null,
      timestamp: at(minutesAgo),
    }))
  );
  await dbWrite.insert(postTags).values(
    fixture.map(({ id, minutesAgo }) => ({
      id: `link-${id}`,
      postId: id,
      tagId: 'tag-moderation',
      createdAt: at(minutesAgo),
    }))
  );

  async function signedRequest(url: URL, userId?: string) {
    const headers = new Headers();
    if (userId) {
      headers.set(
        'authorization',
        `Bearer ${await createStewardTestToken(`steward-${userId}`)}`
      );
    }
    const request = new NextRequest(url, { headers });
    if (userId) expect((await optionalAuth(request))?.userId).toBe(userId);
    return request;
  }

  async function webTag(userId?: string, limit = 20, offset = 0) {
    const url = new URL(`http://localhost/api/trending/${TAG}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const response = await tagPage(await signedRequest(url, userId), {
      params: Promise.resolve({ tag: TAG }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      posts: Array<{ id: string }>;
      total: number;
    };
    return { ids: body.posts.map(({ id }) => id), total: body.total };
  }

  async function webTagCacheControl(userId?: string) {
    const url = new URL(`http://localhost/api/trending/${TAG}`);
    const response = await tagPage(await signedRequest(url, userId), {
      params: Promise.resolve({ tag: TAG }),
    });
    expect(response.status).toBe(200);
    return response.headers.get('cache-control');
  }

  async function webGroupCacheControl(userId?: string) {
    const url = new URL('http://localhost/api/trending/group');
    url.searchParams.set('tags', TAG);
    const response = await groupPage(await signedRequest(url, userId));
    expect(response.status).toBe(200);
    return response.headers.get('cache-control');
  }

  async function webGroup(userId?: string, limit = 50) {
    const url = new URL('http://localhost/api/trending/group');
    url.searchParams.set('tags', TAG);
    url.searchParams.set('limit', String(limit));
    const response = await groupPage(await signedRequest(url, userId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: Array<{ id: string }> };
    return body.posts.map(({ id }) => id);
  }

  async function a2aTag(userId: string, limit = 20, offset = 0) {
    const result = (await FeedAgentExecutor.executeDirectly(
      'stats.posts_by_tag',
      { tag: TAG, limit, offset },
      userId
    )) as { posts: Array<{ id: string }> };
    return result.posts.map(({ id }) => id);
  }

  describe(suite, () => {
    test(cases.web, async () => {
      const full = await webTag(people.viewer);
      const firstPage = await webTag(people.viewer, 2);
      const secondPage = await webTag(people.viewer, 2, 2);
      console.log(
        `TAG_MODERATION web full=${JSON.stringify(full)} page1=${JSON.stringify(firstPage.ids)} page2=${JSON.stringify(secondPage.ids)}`
      );
      expect(full).toEqual({ ids: visibleIds, total: 2 });
      expect(firstPage).toEqual({ ids: visibleIds, total: 2 });
      expect(secondPage).toEqual({ ids: [], total: 2 });
    });

    test(cases.group, async () => {
      const full = await webGroup(people.viewer);
      const window = await webGroup(people.viewer, 1);
      console.log(
        `TAG_MODERATION group full=${JSON.stringify(full)} limit1=${JSON.stringify(window)}`
      );
      expect(full).toEqual(visibleIds);
      expect(window).toEqual(['tag-visible-new']);
    });

    test(cases.a2a, async () => {
      const firstPage = await a2aTag(people.viewer, 2);
      const secondPage = await a2aTag(people.viewer, 2, 2);
      console.log(
        `TAG_MODERATION a2a page1=${JSON.stringify(firstPage)} page2=${JSON.stringify(secondPage)}`
      );
      expect(firstPage).toEqual(visibleIds);
      expect(secondPage).toEqual([]);
    });

    test(cases.others, async () => {
      expect(await webTag()).toEqual({ ids: allIds, total: allIds.length });
      expect(await webTag(people.stranger)).toEqual({
        ids: allIds,
        total: allIds.length,
      });
      expect(await webGroup()).toEqual(allIds);
      expect(await webGroup(people.stranger)).toEqual(allIds);
      expect(await a2aTag(people.stranger)).toEqual(allIds);
    });

    test(cases.cache, async () => {
      const signedTag = await webTagCacheControl(people.viewer);
      const signedGroup = await webGroupCacheControl(people.viewer);
      const anonymousTag = await webTagCacheControl();
      const anonymousGroup = await webGroupCacheControl();
      console.log(
        `TAG_MODERATION cache tag signed=${JSON.stringify(signedTag)} anonymous=${JSON.stringify(anonymousTag)} group signed=${JSON.stringify(signedGroup)} anonymous=${JSON.stringify(anonymousGroup)}`
      );
      for (const header of [signedTag, signedGroup]) {
        expect(header).toContain('private');
        expect(header).not.toContain('public');
        expect(header).not.toContain('s-maxage');
      }
      for (const header of [anonymousTag, anonymousGroup]) {
        expect(header).toContain('public');
        expect(header).toContain('s-maxage');
      }
    });
  });
}
