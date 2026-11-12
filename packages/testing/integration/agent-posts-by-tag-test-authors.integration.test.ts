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
import { db, eq, inArray, posts, postTags, tags, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';
import { executeGetPostsByTag } from '../../mcp/src/handlers/tool-handlers';

const RUN_ID = await generateSnowflakeId();
const CALLER = `f109-tag-caller-${RUN_ID}`;
const AUTHOR_MAIN = `f109-tag-author-main-${RUN_ID}`;
const AUTHOR_TEST_FLAG = `f109-tag-author-testflag-${RUN_ID}`;
const AUTHOR_TEST_PREFIX = `test-f109-tag-author-${RUN_ID}`;
const TAG_NAME = `f109tagtest-${RUN_ID}`;

const T0 = new Date(Date.now() - 60 * 60 * 1000);
T0.setMilliseconds(0);

let tagId: string;
const mainIds: string[] = [];
const testIds: string[] = [];
let futureId: string;
let deletedId: string;
type OwnedRows = {
  userIds: string[];
  tagIds: string[];
  postIds: string[];
  postTagIds: string[];
};
const owned: OwnedRows = {
  userIds: [],
  tagIds: [],
  postIds: [],
  postTagIds: [],
};

async function insertUser(id: string, isTest = false, scope = owned) {
  const [row] = await db
    .insert(users)
    .values({
      id,
      username: id.replace(/[^a-z0-9-]/g, ''),
      displayName: id,
      isTest,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('User insert returned no ownership');
  scope.userIds.push(row.id);
}

async function insertTag(id: string, name: string, scope = owned) {
  const [row] = await db
    .insert(tags)
    .values({ id, name, displayName: name, updatedAt: new Date() })
    .returning({ id: tags.id });
  if (!row) throw new Error('Tag insert returned no ownership');
  scope.tagIds.push(row.id);
  return row.id;
}

async function cleanup(scope: OwnedRows) {
  if (scope.postTagIds.length > 0) {
    await db.delete(postTags).where(inArray(postTags.id, scope.postTagIds));
    expect(
      await db
        .select({ id: postTags.id })
        .from(postTags)
        .where(inArray(postTags.id, scope.postTagIds))
    ).toHaveLength(0);
  }
  if (scope.postIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, scope.postIds));
    expect(
      await db
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, scope.postIds))
    ).toHaveLength(0);
  }
  if (scope.tagIds.length > 0) {
    await db.delete(tags).where(inArray(tags.id, scope.tagIds));
    expect(
      await db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.id, scope.tagIds))
    ).toHaveLength(0);
  }
  if (scope.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, scope.userIds));
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, scope.userIds))
    ).toHaveLength(0);
  }
}

async function insertTaggedPost(
  authorId: string,
  minutesAfterT0: number,
  opts: {
    deleted?: boolean;
    tagId?: string;
    postTagId?: string;
    type?: 'post' | 'article';
  } = {},
  scope = owned
) {
  const id = await generateSnowflakeId();
  const ts = new Date(T0.getTime() + minutesAfterT0 * 60 * 1000);
  const [post] = await db
    .insert(posts)
    .values({
      id,
      content: `f109 tag post ${id}`,
      authorId,
      timestamp: ts,
      createdAt: ts,
      type: opts.type ?? 'post',
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: posts.id });
  if (!post) throw new Error('Post insert returned no ownership');
  scope.postIds.push(post.id);
  const [link] = await db
    .insert(postTags)
    .values({
      id: opts.postTagId ?? (await generateSnowflakeId()),
      postId: id,
      tagId: opts.tagId ?? tagId,
      createdAt: ts,
    })
    .returning({ id: postTags.id });
  if (!link) throw new Error('PostTag insert returned no ownership');
  scope.postTagIds.push(link.id);
  return id;
}

async function fetchA2A(limit = 50, offset = 0, tag = TAG_NAME) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.posts_by_tag',
    { tag, limit, offset } as Record<string, JsonValue>,
    CALLER
  )) as { posts: Array<{ id: string }> };
  return result.posts.map((p) => p.id);
}

async function fetchMCP(limit = 50, offset = 0, tag = TAG_NAME) {
  const result = await executeGetPostsByTag(
    { agentId: 'f109-tag-agent', userId: CALLER },
    { tag, limit, offset }
  );
  return result.posts.map((p) => p.id);
}

beforeAll(async () => {
  await insertUser(CALLER);
  await insertUser(AUTHOR_MAIN);
  await insertUser(AUTHOR_TEST_FLAG, true);
  await insertUser(AUTHOR_TEST_PREFIX);
  tagId = await insertTag(await generateSnowflakeId(), TAG_NAME);
  mainIds.push(await insertTaggedPost(AUTHOR_MAIN, 1));
  mainIds.push(await insertTaggedPost(AUTHOR_MAIN, 2));
  // Test-author posts are the newest, so they take the first page.
  testIds.push(await insertTaggedPost(AUTHOR_TEST_FLAG, 3));
  testIds.push(await insertTaggedPost(AUTHOR_TEST_PREFIX, 4));
  deletedId = await insertTaggedPost(AUTHOR_MAIN, 5, { deleted: true });
  const future = await insertTaggedPost(AUTHOR_MAIN, 24 * 60);
  futureId = future;
});

afterAll(() => cleanup(owned));

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

  it('preserves articles/static authors and offset, tie, empty and unknown-tag boundaries', async () => {
    const name = `f109-boundary-${RUN_ID}`;
    const boundaryTag = await insertTag(await generateSnowflakeId(), name);
    for (const fetch of [fetchA2A, fetchMCP]) {
      expect(await fetch(2, 0, name)).toEqual([]);
      expect(await fetch(2, 0, `f109-unknown-${RUN_ID}`)).toEqual([]);
    }
    const actorIds = StaticDataRegistry.getAllActors()
      .filter((actor) => !actor.isTest && !actor.id.startsWith('test-'))
      .map(({ id }) => id);
    const userRows =
      actorIds.length > 0
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.id, actorIds))
        : [];
    const userIds = new Set(userRows.map(({ id }) => id));
    const actorId = actorIds.find((id) => !userIds.has(id));
    if (!actorId)
      throw new Error('No legitimate registry author without a User row');
    const actorPost = await insertTaggedPost(actorId, 1, {
      tagId: boundaryTag,
    });
    const tiedA = await insertTaggedPost(AUTHOR_MAIN, 2, {
      tagId: boundaryTag,
    });
    const tiedB = await insertTaggedPost(AUTHOR_MAIN, 2, {
      tagId: boundaryTag,
    });
    const article = await insertTaggedPost(AUTHOR_MAIN, 3, {
      tagId: boundaryTag,
      type: 'article',
    });
    await insertTaggedPost(AUTHOR_TEST_PREFIX, 4, { tagId: boundaryTag });
    await insertTaggedPost(AUTHOR_MAIN, 5, {
      tagId: boundaryTag,
      deleted: true,
    });
    await insertTaggedPost(AUTHOR_MAIN, 24 * 60, { tagId: boundaryTag });
    const a2a = await fetchA2A(20, 0, name);
    const mcp = await fetchMCP(20, 0, name);
    expect(new Set(a2a)).toEqual(new Set([actorPost, tiedA, tiedB]));
    expect(new Set(mcp)).toEqual(new Set([actorPost, tiedA, tiedB, article]));
    for (const [fetch, full] of [
      [fetchA2A, a2a],
      [fetchMCP, mcp],
    ] as const) {
      expect(await fetch(1, 1, name)).toEqual(full.slice(1, 2));
      expect(await fetch(2, 2, name)).toEqual(full.slice(2, 4));
      expect(await fetch(2, 99, name)).toEqual([]);
    }
  });

  it('keeps collision rows and cleans a Post acquired before a failed PostTag insert', async () => {
    const existing: OwnedRows = {
      userIds: [],
      tagIds: [],
      postIds: [],
      postTagIds: [],
    };
    const attempted: OwnedRows = {
      userIds: [],
      tagIds: [],
      postIds: [],
      postTagIds: [],
    };
    try {
      const sentinelUser = `f109-control-${await generateSnowflakeId()}`;
      await insertUser(sentinelUser, false, existing);
      const sentinelTag = await insertTag(
        await generateSnowflakeId(),
        `f109-control-${RUN_ID}`,
        existing
      );
      await insertTaggedPost(sentinelUser, 1, { tagId: sentinelTag }, existing);
      const linkId = existing.postTagIds[0];
      if (!linkId) throw new Error('Sentinel PostTag was not acquired');
      const readExisting = async () => ({
        users: await db.select().from(users).where(eq(users.id, sentinelUser)),
        tags: await db.select().from(tags).where(eq(tags.id, sentinelTag)),
        posts: await db
          .select()
          .from(posts)
          .where(inArray(posts.id, existing.postIds)),
        links: await db.select().from(postTags).where(eq(postTags.id, linkId)),
      });
      const before = await readExisting();
      await expect(
        insertUser(sentinelUser, false, attempted)
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertTag(sentinelTag, `f109-control-${RUN_ID}`, attempted)
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      const partialUser = `f109-partial-${await generateSnowflakeId()}`;
      await insertUser(partialUser, false, attempted);
      const partialTag = await insertTag(
        await generateSnowflakeId(),
        `f109-partial-${RUN_ID}`,
        attempted
      );
      await expect(
        insertTaggedPost(
          partialUser,
          1,
          { tagId: partialTag, postTagId: linkId },
          attempted
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(attempted.postIds).toHaveLength(1);
      await cleanup(attempted);
      expect(await readExisting()).toEqual(before);
    } finally {
      await cleanup(attempted);
      await cleanup(existing);
    }
  });
});
