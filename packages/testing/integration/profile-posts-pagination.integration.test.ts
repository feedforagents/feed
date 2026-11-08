/** PRD §12 / MVP phase 5: profile post pagination through real anonymous HTTP. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const schema = z.object({
  type: z.literal('posts'),
  total: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      originalPost: z.object({ id: z.string() }).nullable().optional(),
      isQuote: z.union([z.boolean(), z.literal('')]).optional(),
    })
  ),
});
const ownedUsers: string[] = [],
  ownedPosts: string[] = [],
  visible: Array<{ id: string; timestamp: Date }> = [];
let authorId: string;
let expected: string[];
let quotes: string[];
let visibleRepost: string;
let visibleOriginal: string;
async function postId() {
  return generateSnowflakeId();
}

beforeAll(async () => {
  authorId = await generateSnowflakeId();
  const originalAuthor = await generateSnowflakeId();
  const userIds = [authorId, originalAuthor];
  const now = Date.now();
  const insertedUsers = await db
    .insert(users)
    .values(
      userIds.map((id) => ({
        id,
        username: `profile-page-${id}`,
        updatedAt: new Date(),
      }))
    )
    .returning({ id: users.id });
  ownedUsers.push(...insertedUsers.map((row) => row.id));
  const rows: Array<typeof posts.$inferInsert> = [];
  async function add(
    owner: string,
    content: string,
    milliseconds: number,
    extra: Partial<typeof posts.$inferInsert> = {},
    shown = false
  ) {
    const id = await postId(),
      timestamp = new Date(milliseconds);
    rows.push({
      id,
      authorId: owner,
      content,
      timestamp,
      createdAt: timestamp,
      ...extra,
    });
    if (shown) visible.push({ id, timestamp });
    return id;
  }
  for (let i = 0; i < 6; i++)
    await add(
      authorId,
      `Visible fixture ${i}`,
      now - (Math.floor(i / 2) + 1) * 60_000,
      {},
      true
    );
  const deletedOriginal = await add(
    originalAuthor,
    'Deleted original',
    now - 600_000,
    { deletedAt: new Date(now) }
  );
  const futureOriginal = await add(
    originalAuthor,
    'Future original',
    now + 86_400_000
  );
  const missingOriginal = await postId();
  visibleOriginal = await add(
    originalAuthor,
    'Visible original',
    now - 600_000
  );
  await add(authorId, 'Deleted own post', now - 10_000, {
    deletedAt: new Date(now),
  });
  await add(authorId, 'Future own post', now + 86_400_000);
  quotes = [];
  for (const originalPostId of [
    deletedOriginal,
    futureOriginal,
    missingOriginal,
  ]) {
    await add(authorId, '', now - 10_000, { originalPostId });
    quotes.push(
      await add(
        authorId,
        'Commentary remains visible',
        now - 15_000,
        { originalPostId },
        true
      )
    );
  }
  visibleRepost = await add(
    authorId,
    '',
    now - 50_000,
    { originalPostId: visibleOriginal },
    true
  );
  const insertedPosts = await db
    .insert(posts)
    .values(rows)
    .returning({ id: posts.id });
  ownedPosts.push(...insertedPosts.map((row) => row.id));
  expected = [...visible]
    .sort(
      (a, b) =>
        b.timestamp.getTime() - a.timestamp.getTime() ||
        b.id.localeCompare(a.id)
    )
    .map((row) => row.id);
});

afterAll(async () => {
  if (ownedPosts.length)
    await db.delete(posts).where(inArray(posts.id, ownedPosts));
  if (ownedUsers.length)
    await db.delete(users).where(inArray(users.id, ownedUsers));
});
async function get(query = '') {
  const response = await fetch(
    `${baseUrl}/api/users/${authorId}/posts?type=posts${query}`
  );
  assert.equal(response.status, 200);
  const body = schema.parse(await response.json());
  assert.equal(body.total, body.items.length); // Existing total means this page, not all pages.
  return body;
}

test('returns the requested first page without hidden rows consuming slots', async () => {
  expect((await get('&page=1&limit=4')).items.map((row) => row.id)).toEqual(
    expected.slice(0, 4)
  );
});
test('returns later pages without overlap', async () => {
  const second = (await get('&page=2&limit=4')).items.map((row) => row.id);
  const third = (await get('&page=3&limit=4')).items.map((row) => row.id);
  expect(second).toEqual(expected.slice(4, 8));
  expect(third).toEqual(expected.slice(8));
  expect(new Set([...second, ...third]).size).toBe(6);
});
test('keeps the existing default response and hides future/deleted/simple-repost rows', async () => {
  expect((await get()).items.map((row) => row.id)).toEqual(expected);
});
test('returns an empty page past the end', async () => {
  expect((await get('&page=4&limit=4')).items).toEqual([]);
});
test('preserves quotes as tombstones and hydrates a visible simple repost', async () => {
  const body = await get();
  for (const id of quotes) {
    const row = body.items.find((item) => item.id === id);
    assert.ok(row);
    expect(row.isQuote).toBe(true);
    expect(row.originalPost).toBeNull();
  }
  expect(
    body.items.find((row) => row.id === visibleRepost)?.originalPost?.id
  ).toBe(visibleOriginal);
});
test('keeps timestamp ties ordered by descending id across page boundaries', async () => {
  const actual: string[] = [];
  for (let page = 1; page <= expected.length; page++) {
    const body = await get(`&page=${page}&limit=1`);
    expect(body.items).toHaveLength(1);
    actual.push(body.items[0]!.id);
  }
  expect(actual).toEqual(expected);
});
test('rejects invalid page and limit inputs', async () => {
  for (const query of ['&page=0', '&limit=101', '&limit=0']) {
    const response = await fetch(
      `${baseUrl}/api/users/${authorId}/posts?type=posts${query}`
    );
    expect(response.status).toBe(400);
  }
});
