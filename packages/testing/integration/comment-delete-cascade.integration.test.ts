/** Threaded replies and deletion against PostgreSQL. PRD §12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  subtree:
    'removes descendants and reactions and preserves neighboring threads',
  concurrent:
    'serializes concurrent replies through both web routes and deletion',
  invalid:
    'rejects replies to unavailable parents and preserves top-level comments',
  legacy: 'bounds deletion to its post and finishes on a legacy cycle',
  rollback: 'preserves the subtree and reactions when deletion fails',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks comment deletion in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'comment-delete-cascade',
      file: 'packages/testing/integration/comment-delete-cascade.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const {
    comments,
    createCommentWithParentCheck,
    db,
    eq,
    inArray,
    posts,
    reactions,
    sql,
    userApiKeys,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST: callMcp } = await import(
    '../../../apps/web/src/app/api/mcp/route'
  );
  const { DELETE, GET } = await import(
    '../../../apps/web/src/app/api/comments/[id]/route'
  );
  const { POST: replyToComment } = await import(
    '../../../apps/web/src/app/api/comments/[id]/replies/route'
  );
  const { POST: commentOnPost } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );

  const now = new Date();
  const owner = await generateSnowflakeId();
  const replier = await generateSnowflakeId();
  await db.insert(users).values(
    [owner, replier].map((id) => ({
      id,
      username: `cascade-${id}`,
      updatedAt: now,
    }))
  );

  const mcpKey = generateApiKey();
  await db.insert(userApiKeys).values({
    id: await generateSnowflakeId(),
    userId: replier,
    keyHash: hashApiKey(mcpKey),
  });

  async function newPost() {
    const id = await generateSnowflakeId();
    await db.insert(posts).values({
      id,
      authorId: owner,
      content: 'Comment deletion fixture',
      timestamp: now,
    });
    return id;
  }

  async function commentInput(postId: string, parentCommentId?: string) {
    const id = await generateSnowflakeId();
    return {
      id,
      content: `Fixture comment ${id}`,
      postId,
      authorId: owner,
      parentCommentId,
      updatedAt: now,
    };
  }

  async function newThread(postId: string) {
    const root = await commentInput(postId);
    const reply = await commentInput(postId, root.id);
    const nested = await commentInput(postId, reply.id);
    await db.insert(comments).values([root, reply, nested]);
    return { root: root.id, reply: reply.id, nested: nested.id };
  }

  function request(
    path: string,
    method: string,
    userId: string,
    body?: object
  ) {
    return new NextRequest(
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          authorization: `Bearer steward:test:${userId}`,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    );
  }

  function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function remove(id: string, userId = owner) {
    return DELETE(request(`comments/${id}`, 'DELETE', userId), params(id));
  }

  function addViaComment(parentId: string) {
    return replyToComment(
      request(`comments/${parentId}/replies`, 'POST', replier, {
        content: `Reply via comment to ${parentId}`,
      }),
      params(parentId)
    );
  }

  let postReplyNumber = 0;

  function addViaPost(postId: string, parentCommentId?: string) {
    return commentOnPost(
      request(`posts/${postId}/comments`, 'POST', replier, {
        content: `Reply via post to ${parentCommentId ?? postId} (${++postReplyNumber})`,
        parentCommentId,
      }),
      params(postId)
    );
  }

  async function remainingComments(postId: string) {
    return db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.postId, postId));
  }

  test(cases.subtree, async () => {
    const postId = await newPost();
    const { root, reply, nested } = await newThread(postId);
    const neighbor = await commentInput(postId);
    await db.insert(comments).values(neighbor);
    const likedIds = [root, reply, nested, neighbor.id];
    await db.insert(reactions).values(
      await Promise.all(
        likedIds.map(async (commentId) => ({
          id: await generateSnowflakeId(),
          commentId,
          userId: replier,
        }))
      )
    );

    expect((await remove(root, replier)).status).toBe(403);
    expect(await remainingComments(postId)).toHaveLength(4);
    const removed = await remove(root);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ deletedRepliesCount: 2 });
    expect(await remainingComments(postId)).toEqual([{ id: neighbor.id }]);
    expect(
      await db
        .select({ id: reactions.commentId })
        .from(reactions)
        .where(inArray(reactions.commentId, likedIds))
    ).toEqual([{ id: neighbor.id }]);
    expect(
      (await GET(request(`comments/${nested}`, 'GET', replier), params(nested)))
        .status
    ).toBe(404);

    const mcpResponse = await callMcp(
      new NextRequest('http://comment-delete.test/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'comment-delete.test',
          'X-Feed-Api-Key': mcpKey,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'remaining-comments',
          method: 'tools/call',
          params: { name: 'get_comments', arguments: { postId } },
        }),
      })
    );
    expect(mcpResponse.status).toBe(200);
    const body = (await mcpResponse.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(false);
    const remaining = JSON.parse(body.result.content[0]!.text) as {
      comments: { id: string }[];
    };
    expect(remaining.comments.map((comment) => comment.id)).toEqual([
      neighbor.id,
    ]);
  });

  async function waitForBlockedConnection(blockerPid: number) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [blocked] = await db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
      `);
      if (blocked) return blocked.pid;
      await Bun.sleep(10);
    }
    throw new Error('Expected a blocked connection in the disposable database');
  }

  test(cases.concurrent, async () => {
    for (const add of [
      (_postId: string, parentId: string) => addViaComment(parentId),
      addViaPost,
    ]) {
      const postId = await newPost();
      const { root, nested } = await newThread(postId);
      const existing = await add(postId, nested);
      expect(existing.status).toBe(201);
      const { id: existingId } = (await existing.json()) as { id: string };
      const pending: Promise<Response>[] = [];
      try {
        await db.transaction(async (tx) => {
          // Pause the DELETE while it holds the thread boundary, then start the reply.
          const [blocker] = await tx
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(comments)
            .where(eq(comments.id, root))
            .for('update');
          if (!blocker) throw new Error('Missing fixture root');
          pending.push(remove(root));
          const deletePid = await waitForBlockedConnection(blocker.pid);
          pending.push(add(postId, existingId));
          await waitForBlockedConnection(deletePid);
        });
        const [removed, reply] = await Promise.all(pending);
        expect(removed?.status).toBe(200);
        expect(reply?.status).toBe(404);
        expect(await removed?.json()).toMatchObject({ deletedRepliesCount: 3 });
      } finally {
        await Promise.allSettled(pending);
      }
      expect(await remainingComments(postId)).toEqual([]);
      expect((await add(postId, existingId)).status).toBe(404);
    }
  });

  test(cases.invalid, async () => {
    const postId = await newPost();
    const otherPostId = await newPost();
    const parent = await commentInput(otherPostId);
    const unavailable = await commentInput(postId);
    await db
      .insert(comments)
      .values([parent, { ...unavailable, deletedAt: now }]);

    expect(
      await createCommentWithParentCheck(await commentInput(postId, parent.id))
    ).toEqual({ status: 'parent-post-mismatch' });
    expect(
      await createCommentWithParentCheck(
        await commentInput(postId, unavailable.id)
      )
    ).toEqual({ status: 'parent-deleted' });
    expect((await addViaPost(postId, parent.id)).status).toBe(400);
    expect((await addViaComment(unavailable.id)).status).toBe(400);
    expect((await addViaPost(postId)).status).toBe(201);
    expect(await remainingComments(postId)).toHaveLength(2);
  });

  test(cases.rollback, async () => {
    const postId = await newPost();
    const { root, nested } = await newThread(postId);
    const reactionId = await generateSnowflakeId();
    await db.insert(reactions).values({
      id: reactionId,
      commentId: root,
      userId: replier,
    });
    await db.execute(sql`
      CREATE TABLE "CascadeFixtureReference" (
        "commentId" text PRIMARY KEY REFERENCES ${comments}(id)
      )
    `);
    await db.execute(
      sql`INSERT INTO "CascadeFixtureReference" VALUES (${nested})`
    );

    expect((await remove(root)).status).toBe(500);
    expect(await remainingComments(postId)).toHaveLength(3);
    expect(
      await db.select().from(reactions).where(eq(reactions.id, reactionId))
    ).toHaveLength(1);
  });

  test(cases.legacy, async () => {
    const postId = await newPost();
    const otherPostId = await newPost();
    const root = await commentInput(postId);
    const child = await commentInput(postId, root.id);
    const other = await commentInput(otherPostId, child.id);
    await db
      .insert(comments)
      .values([{ ...root, parentCommentId: child.id }, child, other]);

    const removed = await remove(root.id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ deletedRepliesCount: 1 });
    expect(await remainingComments(postId)).toEqual([]);
    expect(await remainingComments(otherPostId)).toEqual([{ id: other.id }]);
  });
}
