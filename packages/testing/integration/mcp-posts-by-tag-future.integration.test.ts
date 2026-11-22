/**
 * PRD §§8.1–8.2/12 retain consistent hashtag reads (MVP phases 3/5).
 * Real database evidence for eligibility before pagination and stable ties.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetPostsByTag } from '../../mcp/src/handlers/tool-handlers';

const owned = {
  users: [] as string[],
  tags: [] as string[],
  posts: [] as string[],
  memberships: [] as string[],
};
let authorId = '';
let tagName = '';
let tiedTagName = '';
let emptyTagName = '';
const visibleIds: string[] = [];
const tiedIds: string[] = [];
const excludedIds: string[] = [];

async function insertUsers(
  rows: Array<typeof users.$inferInsert>,
  ids = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  ids.push(...inserted.map((row) => row.id));
}

async function fetchPosts(tag = tagName, limit?: number, offset?: number) {
  return (
    await executeGetPostsByTag(
      { agentId: authorId, userId: authorId },
      { tag, limit, offset }
    )
  ).posts;
}

beforeAll(async () => {
  authorId = await generateSnowflakeId();
  const tagId = await generateSnowflakeId();
  const tiedTagId = await generateSnowflakeId();
  const emptyTagId = await generateSnowflakeId();
  tagName = `mcp1674${tagId}`;
  tiedTagName = `mcp1674${tiedTagId}`;
  emptyTagName = `mcp1674${emptyTagId}`;
  const now = new Date();
  await insertUsers([
    {
      id: authorId,
      username: `mcp1674-${authorId}`,
      displayName: 'MCP tag reader',
      updatedAt: now,
    },
  ]);
  const insertedTags = await db
    .insert(tags)
    .values([
      { id: tagId, name: tagName, displayName: 'MCP tag', updatedAt: now },
      {
        id: tiedTagId,
        name: tiedTagName,
        displayName: 'MCP tied tag',
        updatedAt: now,
      },
      {
        id: emptyTagId,
        name: emptyTagName,
        displayName: 'MCP empty tag',
        updatedAt: now,
      },
    ])
    .returning({ id: tags.id });
  owned.tags.push(...insertedTags.map((row) => row.id));
  const rows: Array<typeof posts.$inferInsert> = [];
  const memberships: Array<typeof postTags.$inferInsert> = [];
  for (let index = 0; index < 3; index++) {
    const id = await generateSnowflakeId();
    visibleIds.push(id);
    rows.push({
      id,
      authorId,
      content: `Published MCP tag fixture ${index}`,
      timestamp: new Date(now.getTime() - (index + 3) * 3_600_000),
      type: 'post',
    });
    memberships.push({
      id: `pt-${id}`,
      tagId,
      postId: id,
      createdAt: new Date(now.getTime() - (index + 5) * 60_000),
    });
  }
  const futureId = await generateSnowflakeId();
  const deletedId = await generateSnowflakeId();
  const articleId = await generateSnowflakeId();
  const untaggedId = await generateSnowflakeId();
  visibleIds.unshift(articleId);
  excludedIds.push(futureId, deletedId, untaggedId);
  rows.push(
    {
      id: futureId,
      authorId,
      content: 'Unpublished MCP tag fixture',
      timestamp: new Date(now.getTime() + 86_400_000),
      type: 'post',
    },
    {
      id: deletedId,
      authorId,
      content: 'Deleted MCP tag fixture',
      timestamp: new Date(now.getTime() - 60_000),
      deletedAt: now,
      type: 'post',
    },
    {
      id: articleId,
      authorId,
      content: 'Published tagged article fixture',
      articleTitle: 'MCP tagged article',
      timestamp: new Date(now.getTime() - 120_000),
      type: 'article',
    },
    {
      id: untaggedId,
      authorId,
      content: 'Untagged MCP fixture',
      timestamp: new Date(now.getTime() - 60_000),
      type: 'post',
    }
  );
  for (const [index, postId] of [futureId, deletedId, articleId].entries()) {
    memberships.push({
      id: `pt-${postId}`,
      postId,
      tagId,
      createdAt: new Date(now.getTime() - index * 60_000),
    });
  }
  const tiedTime = new Date(now.getTime() - 60_000);
  for (let index = 0; index < 12; index++) {
    const id = await generateSnowflakeId();
    tiedIds.push(id);
    rows.push({
      id,
      authorId,
      content: `Tied MCP fixture ${index}`,
      timestamp: tiedTime,
      type: 'post',
    });
    memberships.push({
      id: `pt-${id}`,
      postId: id,
      tagId: tiedTagId,
      createdAt: tiedTime,
    });
  }
  const insertedPosts = await db
    .insert(posts)
    .values(rows)
    .returning({ id: posts.id });
  owned.posts.push(...insertedPosts.map((row) => row.id));
  const insertedMemberships = await db
    .insert(postTags)
    .values(memberships)
    .returning({ id: postTags.id });
  owned.memberships.push(...insertedMemberships.map((row) => row.id));
});

afterAll(async () => {
  if (owned.memberships.length)
    await db.delete(postTags).where(inArray(postTags.id, owned.memberships));
  if (owned.posts.length)
    await db.delete(posts).where(inArray(posts.id, owned.posts));
  if (owned.tags.length)
    await db.delete(tags).where(inArray(tags.id, owned.tags));
  if (owned.users.length)
    await db.delete(users).where(inArray(users.id, owned.users));
});

describe('MCP tag post eligibility and stable pages', () => {
  it('retains published posts and articles while excluding future, deleted and untagged controls', async () => {
    const result = await fetchPosts(tagName, 50, 0);
    expect(result.map((post) => post.id)).toEqual(visibleIds);
    for (const id of excludedIds)
      expect(result.some((post) => post.id === id)).toBe(false);
    for (const post of result) {
      expect(Object.keys(post).sort()).toEqual([
        'authorId',
        'content',
        'id',
        'timestamp',
      ]);
      expect(post.authorId).toBe(authorId);
      expect(Number.isFinite(Date.parse(post.timestamp))).toBe(true);
    }
  });

  it('fills the first limit-one page despite newer ineligible memberships', async () => {
    expect((await fetchPosts(tagName, 1, 0)).map((post) => post.id)).toEqual(
      visibleIds.slice(0, 1)
    );
  });

  it('walks every eligible post exactly once at page sizes one and two', async () => {
    for (const limit of [1, 2]) {
      const walked: string[] = [];
      for (let offset = 0; offset < visibleIds.length; offset += limit) {
        walked.push(
          ...(await fetchPosts(tagName, limit, offset)).map((post) => post.id)
        );
      }
      expect(walked).toEqual(visibleIds);
      expect(new Set(walked).size).toBe(visibleIds.length);
      expect(await fetchPosts(tagName, limit, visibleIds.length)).toEqual([]);
    }
  });

  it('preserves explicit offsets and the default window', async () => {
    expect((await fetchPosts(tagName, 2, 2)).map((post) => post.id)).toEqual(
      visibleIds.slice(2)
    );
    expect((await fetchPosts()).map((post) => post.id)).toEqual(visibleIds);
  });

  it('walks post and membership timestamp ties once at sizes one, two and five', async () => {
    const expected = [...tiedIds].sort().reverse();
    for (const limit of [1, 2, 5]) {
      const walked: string[] = [];
      for (let offset = 0; offset < expected.length; offset += limit) {
        walked.push(
          ...(await fetchPosts(tiedTagName, limit, offset)).map(
            (post) => post.id
          )
        );
      }
      console.info(
        'MCP1674_TIE_WALK',
        JSON.stringify({
          limit,
          expected: expected.length,
          walked: walked.length,
          unique: new Set(walked).size,
        })
      );
      expect(walked).toEqual(expected);
      expect(new Set(walked).size).toBe(expected.length);
      expect(await fetchPosts(tiedTagName, limit, expected.length)).toEqual([]);
    }
  });

  it('returns empty collections for an empty or missing tag', async () => {
    expect(await fetchPosts(emptyTagName, 1, 0)).toEqual([]);
    expect(await fetchPosts(`${emptyTagName}missing`, 1, 0)).toEqual([]);
  });

  it('does not claim a preexisting user after a failed atomic fixture insert', async () => {
    const attempted: string[] = [];
    const extraId = await generateSnowflakeId();
    let uniqueViolation = false;
    try {
      await insertUsers(
        [
          {
            id: extraId,
            username: `mcp1674-${extraId}`,
            updatedAt: new Date(),
          },
          {
            id: authorId,
            username: `mcp1674-collision-${extraId}`,
            updatedAt: new Date(),
          },
        ],
        attempted
      );
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('cause' in error))
        throw error;
      const cause = error.cause;
      if (
        typeof cause !== 'object' ||
        cause === null ||
        !('code' in cause) ||
        cause.code !== '23505'
      )
        throw error;
      uniqueViolation = true;
    }
    expect(uniqueViolation).toBe(true);
    expect(attempted).toEqual([]);
    const remaining = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [authorId, extraId]));
    expect(remaining.map((row) => row.id)).toEqual([authorId]);
  });
});
