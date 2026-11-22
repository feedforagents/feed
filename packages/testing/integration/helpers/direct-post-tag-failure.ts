// Isolated real-service/DB fixture. Only invoked by the integration test.
import assert from 'node:assert/strict';
import {
  closeDatabase,
  db,
  eq,
  inArray,
  posts,
  postTags,
  tags,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeDirectPost } from '../../../agents/src/autonomous/DirectExecutors';

const [scenario, content, tagLabel] = process.argv.slice(2);
assert.ok(scenario && content && tagLabel);
try {
  const userId = await generateSnowflakeId();
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
    } else {
      assert.equal(result.success, true);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.id, result.postId);
      assert.equal(stored[0]?.content, content);
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
} finally {
  await closeDatabase();
}

process.exit(0);
