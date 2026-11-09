/**
 * Agent posts-by-tag tools (A2A stats.posts_by_tag, MCP
 * get_posts_by_tag) against a real database: the posts an agent reads
 * for a tag must obey the same test-author rule as every other post
 * list.
 *
 * The canonical post query (DatabaseService.getRecentPosts) excludes
 * test authors in SQL before paginating, with both conditions:
 * authorId NOT LIKE 'test-%' and NOT EXISTS (users.isTest). The web
 * hashtag surface (#1685), the agent feed tools (#1740), and the
 * favorites surfaces (#1670/#1791/#1794) all apply the same rule.
 * These two tag handlers query the db directly and, after #1669/#1674
 * added the deleted/future bounds, still applied neither test-author
 * condition — so a test account's tagged posts filled the first page
 * of an agent's tag read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';
import { executeGetPostsByTag } from '../../mcp/src/handlers/tool-handlers';

const CALLER = 'f109-tag-caller';
const AUTHOR_MAIN = 'f109-tag-author-main';
const AUTHOR_TEST_FLAG = 'f109-tag-author-testflag';
const AUTHOR_TEST_PREFIX = 'test-f109-tag-author';
const TAG_NAME = 'f109tagtest';

const T0 = new Date(Date.now() - 60 * 60 * 1000);
T0.setMilliseconds(0);

let tagId: string;
const mainIds: string[] = [];
const testIds: string[] = [];
let futureId: string;
let deletedId: string;
const allPostIds: string[] = [];

async function insertUser(id: string, isTest = false) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    isTest,
    updatedAt: new Date(),
  });
}

async function insertTaggedPost(
  authorId: string,
  minutesAfterT0: number,
  opts: { deleted?: boolean } = {}
) {
  const id = await generateSnowflakeId();
  const ts = new Date(T0.getTime() + minutesAfterT0 * 60 * 1000);
  await db.insert(posts).values({
    id,
    content: `f109 tag post ${id}`,
    authorId,
    timestamp: ts,
    createdAt: ts,
    type: 'post',
    deletedAt: opts.deleted ? new Date() : null,
  });
  await db.insert(postTags).values({
    id: await generateSnowflakeId(),
    postId: id,
    tagId,
    createdAt: ts,
  });
  allPostIds.push(id);
  return id;
}

async function fetchA2A(limit = 50, offset = 0) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.posts_by_tag',
    { tag: TAG_NAME, limit, offset } as Record<string, JsonValue>,
    CALLER
  )) as { posts: Array<{ id: string }> };
  return result.posts.map((p) => p.id);
}

async function fetchMCP(limit = 50, offset = 0) {
  const result = await executeGetPostsByTag(
    { agentId: 'f109-tag-agent', userId: CALLER },
    { tag: TAG_NAME, limit, offset }
  );
  return result.posts.map((p) => p.id);
}

beforeAll(async () => {
  await insertUser(CALLER);
  await insertUser(AUTHOR_MAIN);
  await insertUser(AUTHOR_TEST_FLAG, true);
  await insertUser(AUTHOR_TEST_PREFIX);
  tagId = await generateSnowflakeId();
  await db.insert(tags).values({
    id: tagId,
    name: TAG_NAME,
    displayName: TAG_NAME,
    updatedAt: new Date(),
  });
  mainIds.push(await insertTaggedPost(AUTHOR_MAIN, 1));
  mainIds.push(await insertTaggedPost(AUTHOR_MAIN, 2));
  // Test-author posts are the newest, so they take the first page.
  testIds.push(await insertTaggedPost(AUTHOR_TEST_FLAG, 3));
  testIds.push(await insertTaggedPost(AUTHOR_TEST_PREFIX, 4));
  deletedId = await insertTaggedPost(AUTHOR_MAIN, 5, { deleted: true });
  const future = await insertTaggedPost(AUTHOR_MAIN, 24 * 60);
  futureId = future;
});

afterAll(async () => {
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagId]));
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        CALLER,
        AUTHOR_MAIN,
        AUTHOR_TEST_FLAG,
        AUTHOR_TEST_PREFIX,
      ])
    );
});

describe('agent posts-by-tag test-author exclusion', () => {
  it('A2A stats.posts_by_tag returns only the real author’s posts', async () => {
    const ids = await fetchA2A();
    expect(new Set(ids)).toEqual(new Set(mainIds));
    for (const id of testIds) expect(ids).not.toContain(id);
  });

  it('MCP get_posts_by_tag returns only the real author’s posts', async () => {
    const ids = await fetchMCP();
    expect(new Set(ids)).toEqual(new Set(mainIds));
    for (const id of testIds) expect(ids).not.toContain(id);
  });

  it('first page (limit=2) is full of real posts on both handlers', async () => {
    const a2a = await fetchA2A(2, 0);
    expect(new Set(a2a)).toEqual(new Set(mainIds));
    const mcp = await fetchMCP(2, 0);
    expect(new Set(mcp)).toEqual(new Set(mainIds));
  });

  it('guard: future-dated and soft-deleted posts stay hidden on both', async () => {
    const a2a = await fetchA2A();
    expect(a2a).not.toContain(futureId);
    expect(a2a).not.toContain(deletedId);
    const mcp = await fetchMCP();
    expect(mcp).not.toContain(futureId);
    expect(mcp).not.toContain(deletedId);
  });
});
