/** PRD §8.2/§12: existing comment eligibility and shared notifications over MCP. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  and,
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  reactions,
  userApiKeys,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '../../api/src/utils/api-keys';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const owned = {
  users: [] as string[],
  keys: [] as string[],
  posts: [] as string[],
  comments: [] as string[],
  blocks: [] as string[],
};
const ids = new Map<string, string>();
const keys = new Map<string, string>();
const resultSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object({
    isError: z.boolean(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  }),
});
function id(label: string) {
  const value = ids.get(label);
  assert.ok(value, `Missing owned ${label}`);
  return value;
}
function key(label: string) {
  const value = keys.get(label);
  assert.ok(value, `Missing owned ${label} key`);
  return value;
}
async function request(method: string, params: object, apiKey = key('liker')) {
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'X-Feed-Api-Key': apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  return { response, requestId };
}
async function tool(
  name: string,
  args: Record<string, string>,
  actor = 'liker'
) {
  const { response, requestId } = await request(
    'tools/call',
    { name, arguments: args },
    key(actor)
  );
  expect(response.status).toBe(200);
  const body = resultSchema.parse(await response.json());
  expect(body.id).toBe(requestId);
  expect(body.result.content).toHaveLength(1);
  return body.result;
}
async function like(
  commentId: string,
  actor = 'liker',
  extra: Record<string, string> = {}
) {
  const result = await tool('like_comment', { commentId, ...extra }, actor);
  expect(result.isError).toBe(false);
  expect(
    z
      .object({ success: z.literal(true) })
      .parse(JSON.parse(result.content[0]!.text))
  ).toEqual({ success: true });
}
async function snapshot() {
  const [likes, notes] = await Promise.all([
    db
      .select({
        id: reactions.id,
        userId: reactions.userId,
        commentId: reactions.commentId,
        type: reactions.type,
      })
      .from(reactions)
      .where(inArray(reactions.userId, owned.users)),
    db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        actorId: notifications.actorId,
        commentId: notifications.commentId,
        postId: notifications.postId,
        type: notifications.type,
      })
      .from(notifications)
      .where(inArray(notifications.userId, owned.users)),
  ]);
  return {
    likes: likes.sort((a, b) => a.id.localeCompare(b.id)),
    notes: notes.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
async function commentLikes(label: string) {
  return db
    .select({ userId: reactions.userId })
    .from(reactions)
    .where(and(eq(reactions.commentId, id(label)), eq(reactions.type, 'like')));
}
async function commentNotes(label: string) {
  return db
    .select({
      userId: notifications.userId,
      actorId: notifications.actorId,
      commentId: notifications.commentId,
      postId: notifications.postId,
      type: notifications.type,
    })
    .from(notifications)
    .where(eq(notifications.commentId, id(label)));
}

beforeAll(async () => {
  for (const label of [
    'author',
    'liker',
    'post',
    'live',
    'reverse',
    'deleted',
    'spoof',
    'blocked',
    'unknown',
  ])
    ids.set(label, await generateSnowflakeId());
  const insertedUsers = await db
    .insert(users)
    .values(
      ['author', 'liker'].map((label, index) => ({
        id: id(label),
        username: `mcp1683_${id(label)}`,
        displayName: `Owned comment ${label}`,
        virtualBalance: String((index + 1) * 111),
        updatedAt: new Date(),
      }))
    )
    .returning({ id: users.id });
  owned.users.push(...insertedUsers.map((row) => row.id));
  for (const label of ['author', 'liker']) {
    const raw = generateApiKey();
    const inserted = await db
      .insert(userApiKeys)
      .values({
        id: await generateSnowflakeId(),
        userId: id(label),
        keyHash: hashApiKey(raw),
        name: 'Owned comment-like HTTP regression',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning({ id: userApiKeys.id });
    owned.keys.push(...inserted.map((row) => row.id));
    keys.set(label, raw);
  }
  const insertedPosts = await db
    .insert(posts)
    .values({
      id: id('post'),
      authorId: id('author'),
      content: 'Owned MCP comment-like fixture',
    })
    .returning({ id: posts.id });
  owned.posts.push(...insertedPosts.map((row) => row.id));
  const insertedComments = await db
    .insert(comments)
    .values(
      ['live', 'reverse', 'deleted', 'spoof', 'blocked'].map((label) => ({
        id: id(label),
        postId: id('post'),
        authorId: id(label === 'reverse' ? 'liker' : 'author'),
        content: `Owned ${label} comment`,
        deletedAt: label === 'deleted' ? new Date() : null,
        updatedAt: new Date(),
      }))
    )
    .returning({ id: comments.id });
  owned.comments.push(...insertedComments.map((row) => row.id));
});
afterAll(async () => {
  // Actor ownership also covers orphan reactions created by a failing baseline.
  if (owned.users.length) {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, owned.users));
    await db.delete(reactions).where(inArray(reactions.userId, owned.users));
  }
  if (owned.blocks.length)
    await db.delete(userBlocks).where(inArray(userBlocks.id, owned.blocks));
  if (owned.comments.length)
    await db.delete(comments).where(inArray(comments.id, owned.comments));
  if (owned.posts.length)
    await db.delete(posts).where(inArray(posts.id, owned.posts));
  if (owned.keys.length)
    await db.delete(userApiKeys).where(inArray(userApiKeys.id, owned.keys));
  if (owned.users.length)
    await db.delete(users).where(inArray(users.id, owned.users));
});

test('discovers like_comment and binds two native keys to distinct accounts', async () => {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Comment-like HTTP regression', version: '1' },
  });
  expect(init.response.status).toBe(200);
  expect(
    z
      .object({ result: z.object({ protocolVersion: z.string() }) })
      .parse(await init.response.json()).result.protocolVersion
  ).toBeTruthy();
  const listing = await request('tools/list', {});
  expect(listing.response.status).toBe(200);
  const body = z
    .object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    })
    .parse(await listing.response.json());
  expect(body.result.tools.some((row) => row.name === 'like_comment')).toBe(
    true
  );
  for (const [actor, balance] of [
    ['author', '111.00'],
    ['liker', '222.00'],
  ] as const) {
    const result = await tool('get_balance', {}, actor);
    expect(result.isError).toBe(false);
    expect(
      z
        .object({ balance: z.string() })
        .parse(JSON.parse(result.content[0]!.text)).balance
    ).toBe(balance);
  }
});
test('rejects missing and invalid keys before domain writes', async () => {
  const before = await snapshot();
  for (const raw of ['', generateApiKey()]) {
    const { response } = await request(
      'tools/call',
      { name: 'like_comment', arguments: { commentId: id('live') } },
      raw
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('ApiKey');
    await response.arrayBuffer();
  }
  expect(await snapshot()).toEqual(before);
});
test('unknown comment rejection leaves reactions and notifications unchanged', async () => {
  const before = await snapshot();
  const result = await tool('like_comment', { commentId: id('unknown') });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Comment');
  expect(await snapshot()).toEqual(before);
});
test('deleted comment rejection precedes fresh or pre-existing likes', async () => {
  const before = await snapshot();
  let result = await tool('like_comment', { commentId: id('deleted') });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Cannot like deleted comment');
  expect(await snapshot()).toEqual(before);
  // Historical likes remain removable; rejection must not turn into replay success.
  const inserted = await db
    .insert(reactions)
    .values({
      id: await generateSnowflakeId(),
      commentId: id('deleted'),
      userId: id('liker'),
      type: 'like',
    })
    .returning({ id: reactions.id });
  try {
    const seeded = await snapshot();
    result = await tool('like_comment', { commentId: id('deleted') });
    expect(result.isError).toBe(true);
    expect(await snapshot()).toEqual(seeded);
  } finally {
    await db.delete(reactions).where(
      inArray(
        reactions.id,
        inserted.map((row) => row.id)
      )
    );
  }
});
test('invalid arguments reject before mutation', async () => {
  const before = await snapshot();
  const result = await tool('like_comment', { commentId: '' });
  expect(result.isError).toBe(true);
  expect(await snapshot()).toEqual(before);
});
test('fresh live like and sequential replay persist one reaction and one author notification', async () => {
  await like(id('live'));
  expect(await commentLikes('live')).toEqual([{ userId: id('liker') }]);
  expect(await commentNotes('live')).toEqual([
    {
      userId: id('author'),
      actorId: id('liker'),
      commentId: id('live'),
      postId: id('post'),
      type: 'reaction',
    },
  ]);
  const once = await snapshot();
  await like(id('live'));
  expect(await snapshot()).toEqual(once);
});
test('self-like changes only its own reaction, without self notification', async () => {
  const notes = await commentNotes('live');
  await like(id('live'), 'author');
  expect((await commentLikes('live')).map((row) => row.userId).sort()).toEqual(
    [id('author'), id('liker')].sort()
  );
  expect(await commentNotes('live')).toEqual(notes);
});
test('reverse account and ignored owner arguments retain authenticated actor IDs', async () => {
  await like(id('reverse'), 'author');
  expect(await commentLikes('reverse')).toEqual([{ userId: id('author') }]);
  expect(await commentNotes('reverse')).toEqual([
    {
      userId: id('liker'),
      actorId: id('author'),
      commentId: id('reverse'),
      postId: id('post'),
      type: 'reaction',
    },
  ]);
  await like(id('spoof'), 'liker', {
    userId: id('author'),
    agentId: id('author'),
  });
  expect(await commentLikes('spoof')).toEqual([{ userId: id('liker') }]);
  expect(await commentNotes('spoof')).toEqual([
    {
      userId: id('author'),
      actorId: id('liker'),
      commentId: id('spoof'),
      postId: id('post'),
      type: 'reaction',
    },
  ]);
});
test('shared notification service suppresses blocked-user notifications without inventing like policy', async () => {
  const inserted = await db
    .insert(userBlocks)
    .values({
      id: await generateSnowflakeId(),
      blockerId: id('author'),
      blockedId: id('liker'),
    })
    .returning({ id: userBlocks.id });
  owned.blocks.push(...inserted.map((row) => row.id));
  try {
    await like(id('blocked'));
    expect(await commentLikes('blocked')).toEqual([{ userId: id('liker') }]);
    expect(await commentNotes('blocked')).toEqual([]);
  } finally {
    await db.delete(userBlocks).where(
      inArray(
        userBlocks.id,
        inserted.map((row) => row.id)
      )
    );
    for (const row of inserted) {
      const at = owned.blocks.indexOf(row.id);
      if (at >= 0) owned.blocks.splice(at, 1);
    }
  }
});
