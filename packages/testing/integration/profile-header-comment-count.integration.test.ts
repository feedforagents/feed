/** Retained profile and replies counts agree. PRD §12 and MVP Phase 5. */
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

const suite = 'profile header comment count';
const cases = {
  replies: 'replies tab returns and counts only non-deleted replies',
  byId: 'by-ID profile header count equals the replies total',
  byUsername: 'by-username profile header count equals the replies total',
  control: 'control user with only live replies retains its count',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks profile comment counts in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'profile-header-comment-count',
      file: 'packages/testing/integration/profile-header-comment-count.integration.test.ts',
      cases: Object.values(cases).map((name) => suite + ' > ' + name),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  // This Next.js build marker has no runtime behavior.
  mock.module('server-only', () => ({}));

  const { cachedDb } = await import('@feed/api');
  const { closeDatabase, comments, db, posts, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: getReplies } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  );
  const { GET: getProfileById } = await import(
    '../../../apps/web/src/app/api/users/[userId]/profile/route'
  );
  const { GET: getProfileByUsername } = await import(
    '../../../apps/web/src/app/api/users/by-username/[username]/route'
  );

  let targetId: string;
  let targetUsername: string;
  let controlId: string;
  let visibleReplyIds: string[];

  beforeAll(async () => {
    const [
      target,
      author,
      control,
      post,
      first,
      second,
      deleted,
      controlReply,
    ] = await Promise.all([
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
    visibleReplyIds = [first, second];

    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const username = (id: string) => 'f196-' + id;
    targetUsername = username(target);

    await db.insert(users).values(
      [target, author, control].map((id) => ({
        id,
        username: username(id),
        isTest: false,
        isBanned: false,
        updatedAt: now,
      }))
    );
    await db.insert(posts).values({
      id: post,
      authorId: author,
      content: 'host post',
      timestamp: past,
      createdAt: past,
    });
    await db.insert(comments).values(
      [
        { id: first, authorId: target, content: 'visible reply one' },
        { id: second, authorId: target, content: 'visible reply two' },
        {
          id: deleted,
          authorId: target,
          content: 'reply the author deleted',
          deletedAt: now,
        },
        {
          id: controlReply,
          authorId: control,
          content: 'control visible reply',
        },
      ].map((reply) => ({
        ...reply,
        postId: post,
        createdAt: now,
        updatedAt: now,
      }))
    );
  });

  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  async function callReplies(userId: string) {
    const response = await getReplies(
      new NextRequest(
        'http://localhost/api/users/' +
          userId +
          '/posts?type=replies&limit=100&page=1'
      ),
      { params: Promise.resolve({ userId }) }
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
  }

  async function commentCount(response: Response) {
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { stats: { comments: number } };
    };
    return body.user.stats.comments;
  }

  describe(suite, () => {
    it(cases.replies, async () => {
      const body = await callReplies(targetId);
      expect(body.total).toBe(2);
      expect(body.items.map(({ id }) => id).sort()).toEqual(
        visibleReplyIds.sort()
      );
    });

    it(cases.byId, async () => {
      const response = await getProfileById(
        new NextRequest('http://localhost/api/users/' + targetId + '/profile'),
        { params: Promise.resolve({ userId: targetId }) }
      );
      expect(await commentCount(response)).toBe(2);
    });

    it(cases.byUsername, async () => {
      const response = await getProfileByUsername(
        new NextRequest(
          'http://localhost/api/users/by-username/' + targetUsername
        ),
        { params: Promise.resolve({ username: targetUsername }) }
      );
      expect(await commentCount(response)).toBe(2);
    });

    it(cases.control, async () => {
      const body = await callReplies(controlId);
      expect(body.total).toBe(1);
      const stats = await cachedDb.getUserProfileStats(controlId);
      expect(stats.comments).toBe(1);
    });
  });
}
