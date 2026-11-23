/** Retained A2A shares must use the canonical web/MCP service (PRD §12).
 * These real HTTP requests use owned per-user keys, not a server bypass.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  and,
  dbWrite as db,
  eq,
  gameOnboarding,
  inArray,
  notifications,
  posts,
  shares,
  sql,
  userApiKeys,
  userBlocks,
  users,
} from '@feed/db';
import {
  generateSnowflakeId,
  isValidSnowflakeId,
  type JsonValue,
} from '@feed/shared';
import { z } from 'zod';

const databaseURL = process.env.DATABASE_URL ?? '';
const database = new URL(databaseURL);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseURL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(BASE_URL);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
for (const configured of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (configured && new URL(configured).origin !== server.origin)
    throw new Error('Fixture HTTP origins must agree');

function receipts() {
  return {
    notifications: new Map<string, string>(),
    shares: new Map<string, string>(),
    posts: new Map<string, string>(),
    userBlocks: new Map<string, string>(),
    userApiKeys: new Map<string, string>(),
    users: new Map<string, string>(),
  };
}
const owned = receipts();
const controls = receipts();
const dependents = new Map<string, string>();
const ShareResult = z.object({
  success: z.boolean(),
  shareId: z.string().optional(),
  repostId: z.string().optional(),
  shareCount: z.number().optional(),
});
const Envelope = z.object({
  result: z.object({
    contextId: z.string(),
    status: z.object({
      state: z.string(),
      message: z
        .object({ parts: z.array(z.object({ text: z.string().optional() })) })
        .optional(),
    }),
    artifacts: z
      .array(
        z.object({
          parts: z.array(
            z.object({ kind: z.string(), data: ShareResult.optional() })
          ),
        })
      )
      .optional(),
  }),
});
let agentId = '';
let authorId = '';
let blockerId = '';
let apiKey = '';
let firstKeyUse = new Date();

async function newId() {
  const id = await generateSnowflakeId();
  assert.ok(isValidSnowflakeId(id));
  return id;
}
async function createUser(target = owned) {
  const id = await newId();
  const [row] = await db
    .insert(users)
    .values({
      id,
      username: `a2ashare_${id}`,
      displayName: `Share fixture ${id}`,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  assert.ok(row);
  target.users.set(row.id, row.canonical);
  return row.id;
}
async function createPost(
  author = authorId,
  options: { future?: boolean; deleted?: boolean; target?: typeof owned } = {}
) {
  const [row] = await db
    .insert(posts)
    .values({
      id: await newId(),
      authorId: author,
      content: 'Owned A2A share target',
      timestamp: new Date(Date.now() + (options.future ? 3600000 : -60000)),
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({
      id: posts.id,
      canonical: sql<string>`to_jsonb(${posts})::text`,
    });
  assert.ok(row);
  (options.target ?? owned).posts.set(row.id, row.canonical);
  return row.id;
}
async function cleanup(target = owned) {
  await db.transaction(async (tx) => {
    for (const [table, rows] of [
      [users, target.users],
      [posts, target.posts],
    ] as const) {
      const ids = [...rows.keys()].sort();
      if (ids.length)
        await tx
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, ids))
          .orderBy(table.id)
          .for('update');
    }
    for (const [table, rows, label] of [
      [notifications, target.notifications, 'Notification'],
      [shares, target.shares, 'Share'],
      [posts, target.posts, 'Post'],
      [userBlocks, target.userBlocks, 'UserBlock'],
      [userApiKeys, target.userApiKeys, 'UserApiKey'],
      [users, target.users, 'User'],
    ] as const) {
      // Reposts reference earlier acquired originals, so remove them first.
      const entries = table === posts ? [...rows].reverse() : [...rows];
      for (const [id, canonical] of entries) {
        const guard =
          table === posts
            ? sql`NOT EXISTS(SELECT 1 FROM "Comment" f WHERE f."postId"=${posts.id}) AND NOT EXISTS(SELECT 1 FROM "Reaction" f WHERE f."postId"=${posts.id}) AND NOT EXISTS(SELECT 1 FROM "Share" f WHERE f."postId"=${posts.id}) AND NOT EXISTS(SELECT 1 FROM "PostTag" f WHERE f."postId"=${posts.id}) AND NOT EXISTS(SELECT 1 FROM "Notification" f WHERE f."postId"=${posts.id}) AND NOT EXISTS(SELECT 1 FROM "Post" f WHERE f."originalPostId"=${posts.id} OR f."commentOnPostId"=${posts.id} OR f."parentCommentId"=${posts.id})`
            : table === users
              ? sql`NOT EXISTS(SELECT 1 FROM "GameOnboarding" f WHERE f."userId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" f WHERE f."userId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "Whitelist" f WHERE f."userId"=${users.id} OR f."grantedBy"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" f WHERE f."updatedBy"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" f WHERE f."userId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "Post" f WHERE f."authorId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "Share" f WHERE f."userId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "Notification" f WHERE f."userId"=${users.id} OR f."actorId"=${users.id}) AND NOT EXISTS(SELECT 1 FROM "UserBlock" f WHERE f."blockerId"=${users.id} OR f."blockedId"=${users.id})`
              : sql`true`;
        // Authentication alone may update this one audit field after the HTTP response.
        const exact =
          table === userApiKeys
            ? sql`(to_jsonb(${userApiKeys})-'lastUsedAt')=(${canonical}::text::jsonb-'lastUsedAt') AND (${userApiKeys.lastUsedAt} IS NULL OR ${userApiKeys.lastUsedAt} BETWEEN ${firstKeyUse.toISOString()}::timestamp AND (clock_timestamp() AT TIME ZONE 'UTC'))`
            : sql`to_jsonb(${table})=${canonical}::text::jsonb`;
        const removed = await tx
          .delete(table)
          .where(and(eq(table.id, id), exact, guard))
          .returning({ id: table.id });
        if (removed.length !== 1)
          throw new Error(`Owned ${label} cleanup refused`);
      }
    }
  });
  for (const rows of Object.values(target)) rows.clear();
}
async function request(
  params: Record<string, JsonValue>,
  key: string | undefined = apiKey,
  contextId = agentId
) {
  const response = await fetch(`${BASE_URL}/api/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'X-Feed-Api-Key': key } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'message/send',
      params: {
        contextId,
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          contextId,
          parts: [
            { kind: 'data', data: { operation: 'social.share_post', params } },
          ],
        },
        configuration: { blocking: true },
      },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const body: JsonValue = await response.json();
  return { status: response.status, body };
}
async function relevant(postId: string) {
  return Array.from(
    await db.execute(
      sql`SELECT 'Share' AS kind,id,to_jsonb(s)::text AS canonical FROM "Share" s WHERE s."postId"=${postId} UNION ALL SELECT 'Post',id,to_jsonb(p)::text FROM "Post" p WHERE p."originalPostId"=${postId} UNION ALL SELECT 'Notification',id,to_jsonb(n)::text FROM "Notification" n WHERE n."postId"=${postId} ORDER BY kind,id`
    )
  );
}
async function share(postId: string, comment?: JsonValue, contextId = agentId) {
  const before = await relevant(postId);
  const response = await request(
    { postId, ...(comment !== undefined ? { comment } : {}) },
    apiKey,
    contextId
  );
  expect(response.status).toBe(200);
  const task = Envelope.parse(response.body).result;
  // Register only returned operation IDs with their exact request relationships,
  // before business assertions, so a genuine baseline regression can be cleaned.
  const data = task.artifacts
    ?.flatMap((a) => a.parts)
    .find((p) => p.kind === 'data')?.data;
  if (data?.shareId) {
    const [row] = await db
      .select({
        id: shares.id,
        canonical: sql<string>`to_jsonb(${shares})::text`,
      })
      .from(shares)
      .where(
        and(
          eq(shares.id, data.shareId),
          eq(shares.userId, agentId),
          eq(shares.postId, postId)
        )
      );
    assert.ok(row);
    assert.ok(!owned.shares.has(row.id));
    owned.shares.set(row.id, row.canonical);
  }
  if (data?.repostId) {
    const [row] = await db
      .select({
        id: posts.id,
        canonical: sql<string>`to_jsonb(${posts})::text`,
        content: posts.content,
      })
      .from(posts)
      .where(
        and(
          eq(posts.id, data.repostId),
          eq(posts.authorId, agentId),
          eq(posts.originalPostId, postId)
        )
      );
    assert.ok(row);
    assert.equal(
      row.content,
      typeof comment === 'string' ? comment.trim() : ''
    );
    assert.ok(!owned.posts.has(row.id));
    owned.posts.set(row.id, row.canonical);
  }
  const previous = new Set(
    before.filter((r) => r.kind === 'Notification').map((r) => String(r.id))
  );
  const created = await db
    .select({
      id: notifications.id,
      canonical: sql<string>`to_jsonb(${notifications})::text`,
      title: notifications.title,
      message: notifications.message,
      commentId: notifications.commentId,
      chatId: notifications.chatId,
      groupId: notifications.groupId,
      inviteId: notifications.inviteId,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, authorId),
        eq(notifications.actorId, agentId),
        eq(notifications.postId, postId),
        eq(notifications.type, 'share')
      )
    );
  const newNotifications = created.filter((n) => !previous.has(n.id));
  if (data?.repostId) {
    assert.equal(newNotifications.length, 1);
    const row = newNotifications[0];
    assert.ok(row);
    assert.equal(row.title, 'Post Shared');
    assert.equal(row.message, `Share fixture ${agentId} shared your post`);
    assert.equal(row.commentId, null);
    assert.equal(row.chatId, null);
    assert.equal(row.groupId, null);
    assert.equal(row.inviteId, null);
    owned.notifications.set(row.id, row.canonical);
  } else assert.equal(newNotifications.length, 0);
  return { task, data, before };
}
async function refused(
  postId: string,
  comment: JsonValue | undefined,
  pattern: RegExp
) {
  const before = await relevant(postId);
  const { task } = await share(postId, comment);
  expect(task.status.state).toBe('failed');
  expect(task.status.message?.parts.map((p) => p.text ?? '').join(' ')).toMatch(
    pattern
  );
  expect(await relevant(postId)).toEqual(before);
}

beforeAll(async () => {
  const response = await fetch(`${BASE_URL}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  // Publish ownership only after the complete setup transaction commits.
  const raw = generateApiKey();
  const setup = await db.transaction(async (tx) => {
    const rows: Array<{ id: string; canonical: string }> = [];
    for (let i = 0; i < 3; i++) {
      const id = await newId();
      const [row] = await tx
        .insert(users)
        .values({
          id,
          username: `a2ashare_${id}`,
          displayName: `Share fixture ${id}`,
          isActor: false,
          updatedAt: new Date(),
        })
        .returning({
          id: users.id,
          canonical: sql<string>`to_jsonb(${users})::text`,
        });
      assert.ok(row);
      rows.push(row);
    }
    const [agent, author, blocker] = rows;
    assert.ok(agent && author && blocker);
    const [key] = await tx
      .insert(userApiKeys)
      .values({
        id: await newId(),
        userId: agent.id,
        keyHash: hashApiKey(raw),
        name: 'Owned A2A share fixture',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning({
        id: userApiKeys.id,
        canonical: sql<string>`to_jsonb(${userApiKeys})::text`,
      });
    assert.ok(key);
    const [block] = await tx
      .insert(userBlocks)
      .values({ id: await newId(), blockerId: blocker.id, blockedId: agent.id })
      .returning({
        id: userBlocks.id,
        canonical: sql<string>`to_jsonb(${userBlocks})::text`,
      });
    assert.ok(block);
    return { rows, key, block, agent, author, blocker };
  });
  for (const row of setup.rows) owned.users.set(row.id, row.canonical);
  agentId = setup.agent.id;
  authorId = setup.author.id;
  blockerId = setup.blocker.id;
  owned.userApiKeys.set(setup.key.id, setup.key.canonical);
  owned.userBlocks.set(setup.block.id, setup.block.canonical);
  apiKey = raw;
  firstKeyUse = new Date();
});
afterAll(async () => {
  for (const [id, canonical] of dependents) {
    const removed = await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, id),
          sql`to_jsonb(${gameOnboarding})=${canonical}::text::jsonb`
        )
      )
      .returning({ id: gameOnboarding.id });
    if (removed.length !== 1) throw new Error('Owned control cleanup refused');
    dependents.delete(id);
  }
  await cleanup(controls);
  await cleanup();
});

// share_post shares the website's per-account limit (SHARE_POST, 5 per
// minute, refused attempts included), so each case acts as its own agent.
async function useFreshAgent() {
  const raw = generateApiKey();
  const setup = await db.transaction(async (tx) => {
    const id = await newId();
    const [agent] = await tx
      .insert(users)
      .values({
        id,
        username: `a2ashare_${id}`,
        displayName: `Share fixture ${id}`,
        isActor: false,
        updatedAt: new Date(),
      })
      .returning({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      });
    assert.ok(agent);
    const [key] = await tx
      .insert(userApiKeys)
      .values({
        id: await newId(),
        userId: agent.id,
        keyHash: hashApiKey(raw),
        name: 'Owned A2A share fixture',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning({
        id: userApiKeys.id,
        canonical: sql<string>`to_jsonb(${userApiKeys})::text`,
      });
    assert.ok(key);
    const [block] = await tx
      .insert(userBlocks)
      .values({ id: await newId(), blockerId, blockedId: agent.id })
      .returning({
        id: userBlocks.id,
        canonical: sql<string>`to_jsonb(${userBlocks})::text`,
      });
    assert.ok(block);
    return { agent, key, block };
  });
  owned.users.set(setup.agent.id, setup.agent.canonical);
  owned.userApiKeys.set(setup.key.id, setup.key.canonical);
  owned.userBlocks.set(setup.block.id, setup.block.canonical);
  agentId = setup.agent.id;
  apiKey = raw;
}

describe('A2A social.share_post real authenticated HTTP', () => {
  beforeEach(useFreshAgent);
  it('creates the quote post in the agent feed and notifies the author', async () => {
    const postId = await createPost();
    const { task, data } = await share(postId, 'worth reading');
    expect(task.status.state).toBe('completed');
    expect(data?.success).toBe(true);
    expect(data?.shareCount).toBe(1);
    expect(data?.repostId).toBeDefined();
    expect(await relevant(postId)).toHaveLength(3);
  });
  it('creates a pure repost when no comment is given', async () => {
    for (const comment of [undefined, '', '   ']) {
      const postId = await createPost();
      const { task, data } = await share(postId, comment);
      expect(task.status.state).toBe('completed');
      expect(data?.repostId).toBeDefined();
      const [row] = await db
        .select({
          content: posts.content,
          originalPostId: posts.originalPostId,
        })
        .from(posts)
        .where(eq(posts.id, data?.repostId ?? ''));
      expect(row).toEqual({ content: '', originalPostId: postId });
    }
  });
  it('refuses a second share of the same post', async () => {
    const postId = await createPost();
    const { task } = await share(postId);
    expect(task.status.state).toBe('completed');
    await refused(postId, undefined, /already shared/i);
  });
  it('refuses to share a post whose author blocked the agent', async () => {
    await refused(
      await createPost(blockerId),
      undefined,
      /Cannot share this post/i
    );
  });
  it('refuses to share a not-yet-published post', async () => {
    await refused(
      await createPost(authorId, { future: true }),
      undefined,
      /not found/i
    );
  });
  it('refuses to share a deleted post', async () => {
    await refused(
      await createPost(authorId, { deleted: true }),
      undefined,
      /Cannot share deleted post/i
    );
  });
  it('rejects provided numeric and object comments before mutation', async () => {
    for (const comment of [12, { text: 'invalid' }])
      await refused(await createPost(), comment, /comment must be a string/i);
  });
  it('requires a real user key and ignores a supplied foreign caller context', async () => {
    const postId = await createPost();
    const before = await relevant(postId);
    for (const key of [undefined, 'feed_invalid_share_key']) {
      const response = await request({ postId }, key === undefined ? '' : key);
      expect(response.status).toBe(401);
    }
    expect(await relevant(postId)).toEqual(before);
    const { task, data } = await share(
      postId,
      'authenticated caller',
      authorId
    );
    expect(task.contextId).toBe(agentId);
    expect(task.status.state).toBe('completed');
    expect(data?.repostId).toBeDefined();
  });
  it('does not acquire failed parent inserts and refuses a foreign cascading reference', async () => {
    const userId = await createUser(controls);
    const postId = await createPost(userId, { target: controls });
    const before = [controls.users.size, controls.posts.size];
    await expect(
      db
        .insert(users)
        .values({
          id: userId,
          username: `collision_${await newId()}`,
          updatedAt: new Date(),
        })
        .returning({ id: users.id })
        .execute()
    ).rejects.toThrow();
    await expect(
      db
        .insert(posts)
        .values({
          id: postId,
          authorId: userId,
          content: 'collision',
          timestamp: new Date(),
        })
        .returning({ id: posts.id })
        .execute()
    ).rejects.toThrow();
    expect([controls.users.size, controls.posts.size]).toEqual(before);
    const [foreign] = await db
      .insert(gameOnboarding)
      .values({ id: await newId(), userId })
      .returning({
        id: gameOnboarding.id,
        canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
      });
    assert.ok(foreign);
    dependents.set(foreign.id, foreign.canonical);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned User cleanup refused'
    );
    expect([controls.users.size, controls.posts.size]).toEqual(before);
    const [retained] = await db
      .select({ canonical: sql<string>`to_jsonb(${gameOnboarding})::text` })
      .from(gameOnboarding)
      .where(eq(gameOnboarding.id, foreign.id));
    expect(retained?.canonical).toBe(foreign.canonical);
    expect(
      await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId))
    ).toEqual([{ id: postId }]);
    const removed = await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, foreign.id),
          sql`to_jsonb(${gameOnboarding})=${foreign.canonical}::text::jsonb`
        )
      )
      .returning({ id: gameOnboarding.id });
    expect(removed).toHaveLength(1);
    dependents.delete(foreign.id);
    await cleanup(controls);
  });
});
