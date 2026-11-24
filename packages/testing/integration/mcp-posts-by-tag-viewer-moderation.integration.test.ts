/** The existing viewer moderation rules apply before the MCP tag limit. */
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP get_posts_by_tag viewer moderation';
const plainCase =
  'hides blocked, muted and blocked-by authors before the tag limit';
const strangerCase =
  'shows every author to a viewer with no moderation relationships';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { db, posts, postTags, tags, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { executeGetPostsByTag } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const callerId = 'f2077-caller';
  const strangerId = 'f2077-stranger';
  const visibleId = 'f2077-visible-author';
  const blockedId = 'f2077-blocked-author';
  const mutedId = 'f2077-muted-author';
  const blockerId = 'f2077-blocker';
  const testAuthorId = 'f2077-test-flagged';
  const tagId = 'f2077-tag-id';
  const tagName = 'f2077-tag';
  const ids = {
    visibleA: 'f2077-post-visible-a',
    visibleB: 'f2077-post-visible-b',
    npc: 'f2077-post-npc',
    blocked: 'f2077-post-blocked',
    muted: 'f2077-post-muted',
    blocker: 'f2077-post-blocker',
    deleted: 'f2077-post-deleted',
    future: 'f2077-post-future',
    testByFlag: 'f2077-post-test-flag',
    testByPrefix: 'f2077-post-test-prefix',
  };

  beforeAll(async () => {
    const now = new Date();
    await db.insert(users).values(
      [
        callerId,
        strangerId,
        visibleId,
        blockedId,
        mutedId,
        blockerId,
        testAuthorId,
      ].map((id) => ({
        id,
        username: id,
        isTest: id === testAuthorId,
        updatedAt: now,
      }))
    );
    await db.insert(tags).values({
      id: tagId,
      name: tagName,
      displayName: 'MCP tag moderation fixture',
      updatedAt: now,
    });
    await db.insert(userBlocks).values([
      { id: 'f2077-block', blockerId: callerId, blockedId },
      { id: 'f2077-reverse-block', blockerId, blockedId: callerId },
    ]);
    await db.insert(userMutes).values({
      id: 'f2077-mute',
      muterId: callerId,
      mutedId,
    });

    function post(
      id: string,
      authorId: string,
      secondsAgo: number,
      options: { deletedAt?: Date } = {}
    ) {
      const timestamp = new Date(now.getTime() - secondsAgo * 1000);
      return {
        id,
        content: id,
        authorId,
        timestamp,
        createdAt: timestamp,
        type: 'post' as const,
        ...options,
      };
    }

    const rows = [
      post(ids.visibleA, visibleId, 60),
      post(ids.visibleB, visibleId, 61),
      post(ids.npc, 'f2077-absent-user-npc', 120),
      post(ids.blocked, blockedId, 30),
      post(ids.muted, mutedId, 31),
      post(ids.blocker, blockerId, 32),
      post(ids.deleted, visibleId, 20, { deletedAt: now }),
      post(ids.future, visibleId, -3600),
      post(ids.testByFlag, testAuthorId, 22),
      post(ids.testByPrefix, 'test-f2077-prefixed', 23),
    ];
    await db.insert(posts).values(rows);
    await db.insert(postTags).values(
      rows.map((row) => ({
        id: `pt-${row.id}`,
        tagId,
        postId: row.id,
        createdAt: row.timestamp,
      }))
    );
  });

  async function tagIds(userId: string, limit: number) {
    const result = await executeGetPostsByTag(
      { agentId: 'f2077-agent', userId },
      { tag: tagName, limit }
    );
    return result.posts.map((post) => post.id);
  }

  describe(suite, () => {
    it(plainCase, async () => {
      // Hidden authors are newer than the visible posts, so an unfiltered
      // limit-3 page would be all hidden. The NPC has no User row.
      expect(await tagIds(callerId, 3)).toEqual([
        ids.visibleA,
        ids.visibleB,
        ids.npc,
      ]);
    });

    it(strangerCase, async () => {
      const got = await tagIds(strangerId, 100);
      for (const id of [ids.visibleA, ids.blocked, ids.muted, ids.blocker]) {
        expect(got).toContain(id);
      }
      for (const id of [
        ids.deleted,
        ids.future,
        ids.testByFlag,
        ids.testByPrefix,
      ]) {
        expect(got).not.toContain(id);
      }
    });
  });
} else {
  it('runs the tag moderation cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-posts-by-tag-viewer-moderation',
      file: 'packages/testing/integration/mcp-posts-by-tag-viewer-moderation.integration.test.ts',
      cases: [plainCase, strangerCase].map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
}
