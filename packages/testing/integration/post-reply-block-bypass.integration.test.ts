/** The /reply NPC path skips the bilateral post-author block check the canonical
 *  comments route and the replies route both enforce. PRD §12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  authorBlock:
    'rejects NPC-post replies when the post author blocked the replier',
  replierBlock:
    'rejects NPC-post replies when the replier blocked the post author',
  allowed: 'allows nonblocked NPC-post replies',
  standardDelegation:
    'still refuses standard-post replies through /reply when blocked',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the post-reply block policy on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-reply-block-policy',
      file: 'packages/testing/integration/post-reply-block-bypass.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { comments, dbWrite, eq, posts, userBlocks, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { POST: postReply } = await import(
    '../../../apps/web/src/app/api/posts/[id]/reply/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();
  const CONTENT =
    'A thoughtful reply to this post about the market outlook today, with a clear view.';

  async function user(isActor = false) {
    const id = await generateSnowflakeId();
    const stewardId = `post-reply-block-${id}`;
    await dbWrite.insert(users).values({
      id,
      stewardId,
      username: stewardId,
      isActor,
      updatedAt: now,
    });
    return { id, stewardId };
  }

  async function npcThread() {
    const npc = await user(true);
    const replier = await user();
    // Synthetic game/NPC post id: parsePostId succeeds, so /reply takes its
    // own path instead of delegating to the canonical comments route.
    const postId = `post-${now.getTime()}-fixture-npc-${await generateSnowflakeId()}`;
    await dbWrite.insert(posts).values({
      id: postId,
      authorId: npc.id,
      content: 'Disposable NPC fixture post',
      timestamp: new Date(now.getTime() - 1000),
    });
    return { npc, replier, postId };
  }

  async function standardThread() {
    const author = await user();
    const replier = await user();
    const postId = await generateSnowflakeId();
    await dbWrite.insert(posts).values({
      id: postId,
      authorId: author.id,
      content: 'Disposable standard fixture post',
      timestamp: new Date(now.getTime() - 1000),
    });
    return { author, replier, postId };
  }

  async function block(blockerId: string, blockedId: string) {
    await dbWrite.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId,
      blockedId,
    });
  }

  type NpcThread = Awaited<ReturnType<typeof npcThread>>;

  async function reply(
    fixture: { replier: { stewardId: string } },
    postId: string
  ) {
    const request = new NextRequest(
      `http://localhost/api/posts/${postId}/reply`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await createStewardTestToken(fixture.replier.stewardId)}`,
        },
        body: JSON.stringify({ content: CONTENT }),
      }
    );
    return postReply(request, { params: Promise.resolve({ id: postId }) });
  }

  function storedComments(postId: string) {
    return dbWrite
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.postId, postId));
  }

  async function expectBlocked(fixture: NpcThread) {
    const response = await reply(fixture, fixture.postId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Cannot comment on this post',
    });
    expect(await storedComments(fixture.postId)).toEqual([]);
  }

  test(cases.authorBlock, async () => {
    const fixture = await npcThread();
    await block(fixture.npc.id, fixture.replier.id);
    await expectBlocked(fixture);
  });

  test(cases.replierBlock, async () => {
    const fixture = await npcThread();
    await block(fixture.replier.id, fixture.npc.id);
    await expectBlocked(fixture);
  });

  test(cases.allowed, async () => {
    const fixture = await npcThread();
    const response = await reply(fixture, fixture.postId);
    expect(response.status).toBe(201);
    expect(await storedComments(fixture.postId)).toEqual([
      { authorId: fixture.replier.id },
    ]);
  });

  test(cases.standardDelegation, async () => {
    const fixture = await standardThread();
    await block(fixture.author.id, fixture.replier.id);
    const response = await reply(fixture, fixture.postId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Cannot comment on this post',
    });
    expect(await storedComments(fixture.postId)).toEqual([]);
  });
}
