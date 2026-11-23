/** The existing viewer moderation rules apply before the MCP feed limit. */
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP query_feed viewer moderation';
const plainCase =
  'hides blocked, muted and blocked-by authors before the plain-feed limit';
const questionCase =
  'hides blocked, muted and blocked-by authors before the question-feed limit';
const strangerCase =
  'shows every author to a viewer with no moderation relationships';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { db, posts, questions, userBlocks, userMutes, users } = await import(
    '@feed/db'
  );
  const { executeQueryFeed } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const callerId = 'f176-caller';
  const strangerId = 'f176-stranger';
  const visibleId = 'f176-visible-author';
  const blockedId = 'f176-blocked-author';
  const mutedId = 'f176-muted-author';
  const blockerId = 'f176-blocker';
  const testAuthorId = 'f176-test-flagged';
  const questionId = 'f176-question';
  const questionNumber = 917601;
  const ids = {
    own: 'f176-post-tie-z',
    visible: 'f176-post-tie-a',
    npc: 'f176-post-npc',
    blocked: 'f176-post-blocked',
    muted: 'f176-post-muted',
    blocker: 'f176-post-blocker',
    deleted: 'f176-post-deleted',
    future: 'f176-post-future',
    testByFlag: 'f176-post-test-flag',
    testByPrefix: 'f176-post-test-prefix',
    questionVisible: 'f176-post-question-visible',
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
    await db.insert(questions).values({
      id: questionId,
      questionNumber,
      text: 'MCP viewer moderation fixture',
      scenarioId: 1,
      outcome: false,
      rank: 1,
      status: 'active',
      resolutionDate: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    });
    await db.insert(userBlocks).values([
      { id: 'f176-block', blockerId: callerId, blockedId },
      { id: 'f176-reverse-block', blockerId, blockedId: callerId },
    ]);
    await db.insert(userMutes).values({
      id: 'f176-mute',
      muterId: callerId,
      mutedId,
    });

    function post(
      id: string,
      authorId: string,
      secondsAgo: number,
      options: { relatedQuestion?: number; deletedAt?: Date } = {}
    ) {
      const timestamp = new Date(now.getTime() - secondsAgo * 1000);
      return {
        id,
        content: id,
        authorId,
        timestamp,
        createdAt: timestamp,
        ...options,
      };
    }

    await db.insert(posts).values([
      post(ids.own, callerId, 60),
      post(ids.visible, visibleId, 60),
      post(ids.npc, 'f176-absent-user-npc', 120),
      post(ids.blocked, blockedId, 30),
      post(ids.muted, mutedId, 31),
      post(ids.blocker, blockerId, 32),
      post(ids.deleted, visibleId, 20, { deletedAt: now }),
      post(ids.future, visibleId, -3600),
      post(ids.testByFlag, testAuthorId, 22),
      post(ids.testByPrefix, 'test-f176-prefixed', 23),
      post(ids.questionVisible, visibleId, 240, {
        relatedQuestion: questionNumber,
      }),
      post('f176-question-blocked', blockedId, 210, {
        relatedQuestion: questionNumber,
      }),
      post('f176-question-muted', mutedId, 211, {
        relatedQuestion: questionNumber,
      }),
      post('f176-question-blocker', blockerId, 212, {
        relatedQuestion: questionNumber,
      }),
    ]);
  });

  async function feedIds(
    userId: string,
    args: { limit: number; questionId?: string }
  ) {
    const result = await executeQueryFeed(
      { agentId: 'f176-agent', userId },
      args
    );
    return result.posts.map((post) => post.id);
  }

  describe(suite, () => {
    it(plainCase, async () => {
      // Hidden authors and filtered rows are newer than these three. The
      // visible tie retains the shipped ID order and the NPC has no User.
      expect(await feedIds(callerId, { limit: 3 })).toEqual([
        ids.own,
        ids.visible,
        ids.npc,
      ]);
    });

    it(questionCase, async () => {
      expect(await feedIds(callerId, { limit: 1, questionId })).toEqual([
        ids.questionVisible,
      ]);
    });

    it(strangerCase, async () => {
      const got = await feedIds(strangerId, { limit: 100 });
      for (const id of [ids.visible, ids.blocked, ids.muted, ids.blocker]) {
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
  it('runs the feed moderation cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-query-feed-viewer-moderation',
      file: 'packages/testing/integration/mcp-query-feed-viewer-moderation.integration.test.ts',
      cases: [plainCase, questionCase, strangerCase].map(
        (name) => `${suite} > ${name}`
      ),
    });
  }, 300_000);
}
