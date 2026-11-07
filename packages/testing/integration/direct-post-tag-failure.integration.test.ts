/** PRD §§12–13 / MVP Phase 3: optional tagging cannot undo a committed post. */
import { afterAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { db, eq, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

// Deterministic provider faults, not recorded/model-generated acceptance proof.
// The actual tag service, HTTP adapter, parser and database remain in use.
let mode = 'http-error';
let requests = 0;
let tagLabel = '';
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
    requests++;
    if (mode === 'http-error') {
      return Response.json(
        { error: { message: 'Injected local provider outage' } },
        { status: 503 }
      );
    }
    const content =
      mode === 'empty'
        ? ''
        : mode === 'malformed'
          ? 'not XML'
          : `<response><tags><tag><displayName>${tagLabel}</displayName><category>Tech</category></tag></tags></response>`;
    return Response.json({
      id: 'local-fixture',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    });
  },
});
delete process.env.SURPLUS_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.GROQ_API_KEY = 'not-a-real-key-loopback-fixture';
process.env.GROQ_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
process.env.GROQ_SMALL_MODEL = 'local-fault-fixture';
const { executeDirectPost } = await import(
  '../../agents/src/autonomous/DirectExecutors'
);
afterAll(() => provider.stop(true));

const scenarios = [
  [
    'http-error',
    'Cobalt satellites trace quiet orbital routes beyond Neptune.',
  ],
  ['empty', 'Saffron bakers measure fragrant pastry layers before sunrise.'],
  [
    'malformed',
    'Quartz musicians practice delicate violin harmonies beside rivers.',
  ],
  [
    'success',
    'Jade botanists catalogue resilient alpine flowers during spring.',
  ],
  ['invalid', 'no'],
] as const;
for (const [scenario, content] of scenarios) {
  test(`preserves real post result for ${scenario} tagging`, async () => {
    const userId = await generateSnowflakeId();
    mode = scenario;
    requests = 0;
    tagLabel = `Acceptance ${userId}`;
    try {
      await db.insert(users).values({
        id: userId,
        username: `tag-failure-${userId}`,
        displayName: 'Synthetic post author',
        updatedAt: new Date(),
      });
      const result = await executeDirectPost({ agentUserId: userId, content });
      const stored = await db
        .select()
        .from(posts)
        .where(eq(posts.authorId, userId));
      if (scenario === 'invalid') {
        assert.equal(result.success, false);
        assert.equal(stored.length, 0);
        assert.equal(requests, 0);
      } else {
        assert.equal(result.success, true);
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.id, result.postId);
        assert.equal(stored[0]?.content, content);
        assert.equal(requests, 1);
        assert.ok(result.postId);
        const links = await db
          .select()
          .from(postTags)
          .where(eq(postTags.postId, result.postId));
        assert.equal(links.length, scenario === 'success' ? 1 : 0);
      }
    } finally {
      const stored = await db
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.authorId, userId));
      if (stored.length)
        await db.delete(postTags).where(
          inArray(
            postTags.postId,
            stored.map((p) => p.id)
          )
        );
      await db.delete(tags).where(eq(tags.displayName, tagLabel));
      await db.delete(posts).where(eq(posts.authorId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
}
