/** Deleted posts stop counting toward profile reactions. Sibling counts
 * (comments #1889, positions #1890, posts #1717) already filter to the
 * visible population; reactions is the only header count with no filter. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'profile header reaction count';
const cases = {
  before: 'by-username profile header reactions counts likes on live targets',
  afterDelete:
    'soft-deleting the liked posts drops them from the reactions count',
  byId: 'by-ID profile header reactions count matches after deletion',
  control:
    'control user with only live likes retains its count, and unlike drops it to zero',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks profile reaction counts in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'profile-header-reaction-count',
      file: 'packages/testing/integration/profile-header-reaction-count.integration.test.ts',
      cases: Object.values(cases).map((name) => suite + ' > ' + name),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  // This Next.js build marker has no runtime behavior.
  mock.module('server-only', () => ({}));

  const { cachedDb } = await import('@feed/api');
  const { closeDatabase, comments, db, eq, posts, reactions, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: getProfileById } = await import(
    '../../../apps/web/src/app/api/users/[userId]/profile/route'
  );
  const { GET: getProfileByUsername } = await import(
    '../../../apps/web/src/app/api/users/by-username/[username]/route'
  );

  let targetId: string;
  let targetUsername: string;
  let controlId: string;
  let controlUsername: string;
  let deletedPostId: string;
  let commentPostId: string;
  let controlReactionId: string;

  beforeAll(async () => {
    const [
      target,
      author,
      control,
      deletedPost,
      cPost,
      comment,
      cPost2,
      targetPostLike,
      targetCommentLike,
      controlLike,
    ] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    targetId = target;
    controlId = control;
    deletedPostId = deletedPost;
    commentPostId = cPost;
    controlReactionId = controlLike;

    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const username = (id: string) => 'f196-' + id;
    targetUsername = username(target);
    controlUsername = username(control);

    await db.insert(users).values(
      [target, author, control].map((id) => ({
        id,
        username: username(id),
        isTest: false,
        isBanned: false,
        updatedAt: now,
      }))
    );
    await db.insert(posts).values([
      {
        id: deletedPost,
        authorId: author,
        content: 'post the target liked before deletion',
        timestamp: past,
        createdAt: past,
      },
      {
        id: cPost,
        authorId: author,
        content: 'post hosting the liked comment',
        timestamp: past,
        createdAt: past,
      },
      {
        id: cPost2,
        authorId: author,
        content: 'control live post',
        timestamp: past,
        createdAt: past,
      },
    ]);
    await db.insert(comments).values({
      id: comment,
      authorId: author,
      content: 'comment the target liked',
      postId: cPost,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(reactions).values([
      {
        id: targetPostLike,
        postId: deletedPost,
        userId: target,
        type: 'like',
      },
      {
        id: targetCommentLike,
        commentId: comment,
        userId: target,
        type: 'like',
      },
      {
        id: controlLike,
        postId: cPost2,
        userId: control,
        type: 'like',
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  async function reactionCountByUsername(username: string) {
    const response = await getProfileByUsername(
      new NextRequest('http://localhost/api/users/by-username/' + username),
      { params: Promise.resolve({ username }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { stats: { reactions: number } };
    };
    return body.user.stats.reactions;
  }

  async function reactionCountById(userId: string) {
    const response = await getProfileById(
      new NextRequest('http://localhost/api/users/' + userId + '/profile'),
      { params: Promise.resolve({ userId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { stats: { reactions: number } };
    };
    return body.user.stats.reactions;
  }

  describe(suite, () => {
    it(cases.before, async () => {
      // Live post like + liked comment on a live post: both count.
      expect(await reactionCountByUsername(targetUsername)).toBe(2);
      expect(await reactionCountByUsername(controlUsername)).toBe(1);
    });

    it(cases.afterDelete, async () => {
      // Soft-delete both liked targets. The comment row itself stays
      // (only its host post is deleted), so the comment-path like must
      // also drop out.
      const now = new Date();
      await db
        .update(posts)
        .set({ deletedAt: now })
        .where(eq(posts.id, deletedPostId));
      await db
        .update(posts)
        .set({ deletedAt: now })
        .where(eq(posts.id, commentPostId));
      expect(await reactionCountByUsername(targetUsername)).toBe(0);
    });

    it(cases.byId, async () => {
      expect(await reactionCountById(targetId)).toBe(0);
      const stats = await cachedDb.getUserProfileStats(targetId);
      expect(stats.reactions).toBe(0);
    });

    it(cases.control, async () => {
      expect(await reactionCountByUsername(controlUsername)).toBe(1);
      const stats = await cachedDb.getUserProfileStats(controlId);
      expect(stats.reactions).toBe(1);
      // Unlike the live post: the count can still reach zero.
      await db.delete(reactions).where(eq(reactions.id, controlReactionId));
      expect(await reactionCountByUsername(controlUsername)).toBe(0);
    });
  });
}
