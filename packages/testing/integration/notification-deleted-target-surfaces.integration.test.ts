/** Real notification target and actor visibility (PRD §§8.1 and 12). */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'notification target visibility on agent surfaces';
const cases = [
  'web list is the oracle: dead targets hidden, unread excludes them',
  'MCP list matches web target and actor visibility',
  'MCP applies visibility before taking the requested page',
  'MCP unread count excludes dead targets and muted or blocked actors',
  'A2A list and unread tally match the web list exactly',
  'mixed history keeps the count and page shape at 120 rows',
  'live and empty legacy targets remain visible on every surface',
] as const;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks notification visibility in disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'notification-deleted-target-surfaces',
      file: 'packages/testing/integration/notification-deleted-target-surfaces.integration.test.ts',
      cases: cases.map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const {
    closeDatabase,
    comments,
    db,
    eq,
    notifications,
    posts,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: webGetNotifications } = await import(
    '../../../apps/web/src/app/api/notifications/route'
  );
  const { FeedAgentExecutor } = await import(
    '../../a2a/src/executors/feed-executor'
  );
  const { executeGetNotifications, executeGetUnreadCount } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const T0 = 1_700_000_000_000;
  const BULK_LIVE = 60;
  const BULK_DEAD = 60;
  const labelOf = new Map<string, string>();

  let recipient: string;
  let bulk: string;
  const bulkLabels = new Map<string, string>();
  let control: string;
  const controlLabels = new Map<string, string>();

  async function mkUser(
    label: string,
    extra: Partial<typeof users.$inferInsert> = {}
  ) {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `ndt_${label}_${id.slice(-6)}`,
      stewardId: id,
      updatedAt: new Date(),
      ...extra,
    });
    return id;
  }

  type NotificationFixture = {
    type: 'like' | 'system';
    actorId?: string | null;
    read?: boolean;
    postId?: string;
    commentId?: string;
  };

  async function mkNotification(
    userId: string,
    labels: Map<string, string>,
    label: string,
    values: NotificationFixture,
    idx: number
  ) {
    const id = await generateSnowflakeId();
    await db.insert(notifications).values({
      id,
      userId,
      title: 'deleted-target fixture',
      message: `ndt ${label}`,
      createdAt: new Date(T0 + idx * 1000),
      ...values,
    });
    labels.set(id, label);
    return id;
  }

  function labelsOf(ids: string[], labels: Map<string, string>): string[] {
    return ids.map((id) => labels.get(id) ?? id).sort();
  }

  async function webList(userId: string) {
    const req = new NextRequest(
      'http://127.0.0.1:3100/api/notifications?limit=100&page=1',
      {
        headers: {
          Authorization: `Bearer ${await createStewardTestToken(userId)}`,
        },
      }
    );
    const res = await webGetNotifications(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<{ id: string }>;
      unreadCount: number;
    };
    return body;
  }

  const agent = (userId: string) => ({ agentId: 'agent', userId });

  beforeAll(async () => {
    recipient = await mkUser('recipient');
    const normal = await mkUser('normal');
    const blockedA = await mkUser('blocked');
    const mutedA = await mkUser('muted');
    const blockerA = await mkUser('blocker');
    const testFlag = await mkUser('testflag', { isTest: true });
    const testPrefixId = `test-ndt-${Date.now()}`;
    await db.insert(users).values({
      id: testPrefixId,
      username: `ndt_testprefix_${testPrefixId.slice(-6)}`,
      updatedAt: new Date(),
    });
    const bannedA = await mkUser('banned', { isBanned: true });

    const livePostId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: livePostId,
      authorId: normal,
      content: 'ndt live post',
      timestamp: new Date(),
      createdAt: new Date(),
      deletedAt: null,
    });
    const deletedPostId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: deletedPostId,
      authorId: normal,
      content: 'ndt deleted post',
      timestamp: new Date(),
      createdAt: new Date(),
      deletedAt: new Date(),
    });
    const gonePostId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: gonePostId,
      authorId: normal,
      content: 'ndt gone post',
      timestamp: new Date(),
      createdAt: new Date(),
      deletedAt: null,
    });

    const liveCommentId = await generateSnowflakeId();
    await db.insert(comments).values({
      id: liveCommentId,
      authorId: normal,
      postId: livePostId,
      content: 'ndt live comment',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const deletedCommentId = await generateSnowflakeId();
    await db.insert(comments).values({
      id: deletedCommentId,
      authorId: normal,
      postId: livePostId,
      content: 'ndt deleted comment',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    });

    // Visible rows are the oldest; the dead-target rows are the newest, so a
    // filter applied after the limit would visibly shrink the page.
    let i = 0;
    await mkNotification(
      recipient,
      labelOf,
      'v01-normal',
      { actorId: normal, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v02-normal-read',
      { actorId: normal, type: 'like', read: true },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v03-system',
      { actorId: null, type: 'system' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v04-testflag',
      { actorId: testFlag, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v05-testprefix',
      { actorId: testPrefixId, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v06-banned',
      { actorId: bannedA, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v07-blocked',
      { actorId: blockedA, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v08-muted',
      { actorId: mutedA, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v09-blocker',
      { actorId: blockerA, type: 'like' },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v10-live-post',
      { actorId: normal, type: 'like', postId: livePostId },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'v11-live-comment',
      { actorId: normal, type: 'like', commentId: liveCommentId },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'd12-deleted-post',
      { actorId: normal, type: 'like', postId: deletedPostId },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'd13-deleted-comment',
      { actorId: normal, type: 'like', commentId: deletedCommentId },
      i++
    );
    await mkNotification(
      recipient,
      labelOf,
      'd14-gone-post',
      { actorId: normal, type: 'like', postId: gonePostId },
      i++
    );
    // Remove the exact fixture post after its notification exists.
    await db.delete(posts).where(eq(posts.id, gonePostId));
    await mkNotification(
      recipient,
      labelOf,
      'd15-missing-comment',
      { actorId: normal, type: 'like', commentId: await generateSnowflakeId() },
      i++
    );

    await db.insert(userBlocks).values([
      { id: crypto.randomUUID(), blockerId: recipient, blockedId: blockedA },
      { id: crypto.randomUUID(), blockerId: blockerA, blockedId: recipient },
    ]);
    await db.insert(userMutes).values({
      id: crypto.randomUUID(),
      muterId: recipient,
      mutedId: mutedA,
    });

    control = await mkUser('control');
    await mkNotification(
      control,
      controlLabels,
      'c1-live-post',
      { actorId: normal, type: 'like', postId: livePostId },
      0
    );
    await mkNotification(
      control,
      controlLabels,
      'c2-empty-targets',
      { actorId: normal, type: 'like', postId: '', commentId: '' },
      1
    );

    // A mixed history with live and deleted targets tests an exact page and
    // unread count across both tools.
    bulk = await mkUser('bulk');
    let j = 1000;
    for (let k = 0; k < BULK_LIVE + BULK_DEAD; k++) {
      const dead = k % 2 === 1;
      await mkNotification(
        bulk,
        bulkLabels,
        dead ? `b-dead-${k}` : `b-live-${k}`,
        {
          actorId: normal,
          type: 'like',
          postId: dead ? deletedPostId : livePostId,
        },
        j++
      );
    }
  });

  afterAll(() => closeDatabase());

  const WEB_VISIBLE = [
    'v01-normal',
    'v02-normal-read',
    'v03-system',
    'v04-testflag',
    'v05-testprefix',
    'v06-banned',
    'v10-live-post',
    'v11-live-comment',
  ];

  describe(suite, () => {
    it(cases[0], async () => {
      const body = await webList(recipient);
      expect(
        labelsOf(
          body.notifications.map((n) => n.id),
          labelOf
        )
      ).toEqual(WEB_VISIBLE);
      expect(body.unreadCount).toBe(7);
    });

    it(cases[1], async () => {
      const result = await executeGetNotifications(agent(recipient), {
        limit: 100,
      });
      expect(
        labelsOf(
          result.notifications.map((n) => n.id),
          labelOf
        )
      ).toEqual(WEB_VISIBLE);
    });

    it(cases[2], async () => {
      const result = await executeGetNotifications(agent(recipient), {
        limit: WEB_VISIBLE.length,
      });
      expect(
        labelsOf(
          result.notifications.map((n) => n.id),
          labelOf
        )
      ).toEqual(WEB_VISIBLE);
    });

    it(cases[3], async () => {
      const result = await executeGetUnreadCount(agent(recipient), {});
      expect(result.unreadCount).toBe(7);
    });

    it(cases[4], async () => {
      const result = (await FeedAgentExecutor.executeDirectly(
        'messaging.get_notifications',
        { limit: 50 },
        recipient
      )) as unknown as {
        unreadCount: number;
        notifications: Array<{ id: string }>;
      };
      expect(
        labelsOf(
          result.notifications.map((n) => n.id),
          labelOf
        )
      ).toEqual(WEB_VISIBLE);
      expect(result.unreadCount).toBe(7);
    });

    it(cases[5], async () => {
      const web = await webList(bulk);
      expect(web.notifications).toHaveLength(BULK_LIVE);
      expect(web.unreadCount).toBe(BULK_LIVE);

      const mcpList = await executeGetNotifications(agent(bulk), {
        limit: 10,
      });
      expect(mcpList.notifications).toHaveLength(10);
      for (const n of mcpList.notifications)
        expect(bulkLabels.get(n.id)).toMatch(/^b-live-/);
      const mcpCount = await executeGetUnreadCount(agent(bulk), {});
      expect(mcpCount.unreadCount).toBe(BULK_LIVE);

      const a2a = (await FeedAgentExecutor.executeDirectly(
        'messaging.get_notifications',
        { limit: 10 },
        bulk
      )) as unknown as {
        unreadCount: number;
        notifications: Array<{ id: string }>;
      };
      expect(a2a.notifications).toHaveLength(10);
      for (const n of a2a.notifications)
        expect(bulkLabels.get(n.id)).toMatch(/^b-live-/);
      expect(a2a.unreadCount).toBe(BULK_LIVE);
    });

    it(cases[6], async () => {
      const web = await webList(control);
      expect(
        labelsOf(
          web.notifications.map((n) => n.id),
          controlLabels
        )
      ).toEqual(['c1-live-post', 'c2-empty-targets']);
      expect(web.unreadCount).toBe(2);

      const mcpList = await executeGetNotifications(agent(control), {
        limit: 100,
      });
      expect(mcpList.notifications).toHaveLength(2);
      const mcpCount = await executeGetUnreadCount(agent(control), {});
      expect(mcpCount.unreadCount).toBe(2);

      const a2a = (await FeedAgentExecutor.executeDirectly(
        'messaging.get_notifications',
        { limit: 50 },
        control
      )) as unknown as {
        unreadCount: number;
        notifications: Array<{ id: string }>;
      };
      expect(a2a.notifications).toHaveLength(2);
      expect(a2a.unreadCount).toBe(2);
    });
  });
}
