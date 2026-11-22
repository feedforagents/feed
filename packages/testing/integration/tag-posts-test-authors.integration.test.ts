/** PRD §§6.1, 12 / MVP Phase 5: public tags retain eligible social posts/articles. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
import { getPostsByTag, StaticDataRegistry } from '@feed/engine';

const runId = crypto.randomUUID();
const tagName = `tag1685${runId.replaceAll('-', '')}`;
const emptyName = `empty1685${runId.replaceAll('-', '')}`;
const owned = {
  users: [] as string[],
  tags: [] as string[],
  posts: [] as string[],
  memberships: [] as string[],
};
const normal = crypto.randomUUID();
const flagged = crypto.randomUUID();
const prefixed = `test-${crypto.randomUUID()}`;
const prefixedWithoutUser = `test-${crypto.randomUUID()}`;
const withoutUser = crypto.randomUUID();
const ids = new Map<string, string>();
const visible = ['normal', 'article', 'npc', 'no-user', 'older'];
const hidden = [
  'flagged',
  'prefixed',
  'prefixed-no-user',
  'flagged-article',
  'future',
  'deleted',
];

function postId(label: string) {
  const id = ids.get(label);
  if (!id) throw new Error(`Missing owned post ${label}`);
  return id;
}

async function acquireUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  ownership.push(...inserted.map((row) => row.id));
}

beforeAll(async () => {
  const now = new Date();
  await acquireUsers([
    {
      id: normal,
      username: `tag-normal-${runId}`,
      isTest: false,
      updatedAt: now,
    },
    {
      id: flagged,
      username: `tag-flag-${runId}`,
      isTest: true,
      updatedAt: now,
    },
    {
      id: prefixed,
      username: `tag-prefix-${runId}`,
      isTest: false,
      updatedAt: now,
    },
  ]);
  const actors = StaticDataRegistry.getAllActors();
  const registryUsers = await db
    .select({ id: users.id, isTest: users.isTest })
    .from(users)
    .where(
      inArray(
        users.id,
        actors.map((actor) => actor.id)
      )
    );
  const testUsers = new Set(
    registryUsers.filter((user) => user.isTest).map((user) => user.id)
  );
  const npc = actors.find(
    (actor) => !testUsers.has(actor.id) && !actor.id.startsWith('test-')
  );
  assert.ok(
    npc,
    'An eligible canonical NPC is required; its User row is never changed'
  );
  expect(
    await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [withoutUser, prefixedWithoutUser]))
  ).toHaveLength(0);
  const insertedTags = await db
    .insert(tags)
    .values([
      {
        id: crypto.randomUUID(),
        name: tagName,
        displayName: 'Owned tag visibility',
        category: 'research',
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        name: emptyName,
        displayName: 'Owned empty tag',
        category: 'research',
        updatedAt: now,
      },
    ])
    .returning({ id: tags.id, name: tags.name });
  owned.tags.push(...insertedTags.map((row) => row.id));
  const tagId = insertedTags.find((row) => row.name === tagName)?.id;
  assert.ok(tagId);
  const definitions = [
    { label: 'flagged', authorId: flagged, memberAgeSeconds: 1 },
    { label: 'prefixed', authorId: prefixed, memberAgeSeconds: 2 },
    {
      label: 'prefixed-no-user',
      authorId: prefixedWithoutUser,
      memberAgeSeconds: 3,
    },
    { label: 'flagged-article', authorId: flagged, memberAgeSeconds: 4 },
    { label: 'future', authorId: normal, memberAgeSeconds: 5 },
    { label: 'deleted', authorId: normal, memberAgeSeconds: 6 },
    { label: 'normal', authorId: normal, memberAgeSeconds: 10 },
    { label: 'article', authorId: normal, memberAgeSeconds: 11 },
    { label: 'npc', authorId: npc.id, memberAgeSeconds: 12 },
    { label: 'no-user', authorId: withoutUser, memberAgeSeconds: 13 },
    { label: 'older', authorId: normal, memberAgeSeconds: 45 * 86400 },
  ];
  const values = definitions.map((definition) => {
    const id = crypto.randomUUID();
    ids.set(definition.label, id);
    const timestamp =
      definition.label === 'future'
        ? new Date(now.getTime() + 3600000)
        : definition.label === 'older'
          ? new Date(now.getTime() - 45 * 86400000)
          : new Date(now.getTime() - 3600000);
    return {
      id,
      authorId: definition.authorId,
      content: `Owned tag post ${definition.label} ${runId}`,
      timestamp,
      createdAt: timestamp,
      type: definition.label.includes('article') ? 'article' : 'post',
      articleTitle: definition.label.includes('article')
        ? 'Retained NPC news article'
        : null,
      fullContent: definition.label.includes('article')
        ? 'The existing article content remains available through the shared tag query.'
        : null,
      deletedAt: definition.label === 'deleted' ? now : null,
    };
  });
  const insertedPosts = await db
    .insert(posts)
    .values(values)
    .returning({ id: posts.id });
  owned.posts.push(...insertedPosts.map((row) => row.id));
  const memberships = await db
    .insert(postTags)
    .values(
      definitions.map((definition) => ({
        id: crypto.randomUUID(),
        postId: postId(definition.label),
        tagId,
        createdAt: new Date(now.getTime() - definition.memberAgeSeconds * 1000),
      }))
    )
    .returning({ id: postTags.id });
  owned.memberships.push(...memberships.map((row) => row.id));
});

afterAll(async () => {
  try {
    for (const [table, values] of [
      [postTags, owned.memberships],
      [posts, owned.posts],
      [tags, owned.tags],
      [users, owned.users],
    ] as const) {
      if (!values.length) continue;
      const removed = await db
        .delete(table)
        .where(inArray(table.id, values))
        .returning({ id: table.id });
      expect(removed).toHaveLength(values.length);
      expect(
        await db
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, values))
      ).toHaveLength(0);
    }
  } finally {
    await closeDatabase();
  }
});

describe('getPostsByTag eligibility with real PostgreSQL', () => {
  it('retains normal posts, articles, canonical NPCs, no-user authors and history', async () => {
    const result = await getPostsByTag(tagName, { limit: 100 });
    const returned = result.posts.map((post) => post.id);
    for (const label of visible) expect(returned).toContain(postId(label));
    expect(
      result.posts.find((post) => post.id === postId('article'))
    ).toMatchObject({
      type: 'article',
      articleTitle: 'Retained NPC news article',
      fullContent:
        'The existing article content remains available through the shared tag query.',
    });
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, withoutUser))
    ).toHaveLength(0);
  });

  it('excludes both test-author forms and existing future/deleted controls', async () => {
    const result = await getPostsByTag(tagName, { limit: 100 });
    for (const label of hidden)
      expect(result.posts.map((post) => post.id)).not.toContain(postId(label));
  });

  it('filters newer hidden memberships before limit one and total count', async () => {
    const result = await getPostsByTag(tagName, { limit: 1, offset: 0 });
    expect(result.posts.map((post) => post.id)).toEqual([postId('normal')]);
    expect(result.total).toBe(visible.length);
  });

  it('walks every eligible page once at limits one and two', async () => {
    for (const limit of [1, 2]) {
      const walked: string[] = [];
      for (let offset = 0; offset < visible.length + limit; offset += limit) {
        const result = await getPostsByTag(tagName, { limit, offset });
        expect(result.total).toBe(visible.length);
        walked.push(...result.posts.map((post) => post.id));
      }
      expect(walked).toEqual(visible.map(postId));
      expect(new Set(walked).size).toBe(visible.length);
    }
  });

  it('preserves name normalization, the default window and explicit offset', async () => {
    expect(
      (await getPostsByTag(tagName.toUpperCase())).posts.map((post) => post.id)
    ).toEqual(visible.map(postId));
    const result = await getPostsByTag(tagName, { limit: 2, offset: 1 });
    expect(result.posts.map((post) => post.id)).toEqual([
      postId('article'),
      postId('npc'),
    ]);
  });

  it('distinguishes an owned empty tag from a missing tag', async () => {
    const empty = await getPostsByTag(emptyName);
    expect(empty.tag?.name).toBe(emptyName);
    expect(empty.posts).toEqual([]);
    expect(empty.total).toBe(0);
    expect(await getPostsByTag(`missing${runId.replaceAll('-', '')}`)).toEqual({
      tag: null,
      posts: [],
      total: 0,
    });
  });

  it('does not acquire cleanup ownership after an atomic setup collision', async () => {
    const fresh = crypto.randomUUID();
    const pending: string[] = [];
    await assert.rejects(
      acquireUsers(
        [
          { id: fresh, updatedAt: new Date() },
          { id: normal, updatedAt: new Date() },
        ],
        pending
      ),
      (error: Error) => {
        const cause = 'cause' in error ? error.cause : error;
        return (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === '23505'
        );
      }
    );
    expect(pending).toHaveLength(0);
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, fresh))
    ).toHaveLength(0);
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, normal))
    ).toHaveLength(1);
  });
});
