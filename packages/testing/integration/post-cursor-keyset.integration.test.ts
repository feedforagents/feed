/**
 * Real database: GET /api/posts keyset pagination must not skip posts that
 * share the page-boundary timestamp. The service methods are called with the
 * cursor the route emits (encodePostCursor of the last post).
 *
 * Fixture rows are owned by this run and removed after the suite.
 * PRD §12 / MVP phase 5: restore the existing chronological feed contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  db,
  encodePostCursor,
  getDbInstance,
  inArray,
  posts,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

type PostPage = Awaited<
  ReturnType<ReturnType<typeof getDbInstance>['getPostsByActor']>
>;

const service = getDbInstance();
const ownedUsers: string[] = [],
  ownedPosts: string[] = [];
const fixtureClock = Math.floor(Date.now() / 1000) * 1000;
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const responseSchema = z.object({
  success: z.literal(true),
  posts: z.array(z.object({ id: z.string() })),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
afterAll(async () => {
  if (ownedPosts.length)
    await db.delete(posts).where(inArray(posts.id, ownedPosts));
  if (ownedUsers.length)
    await db.delete(users).where(inArray(users.id, ownedUsers));
});
async function collectHttpPages(authorId: string, limit: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const query = new URLSearchParams({
      actorId: authorId,
      limit: String(limit),
    });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${baseUrl}/api/posts?${query}`);
    assert.equal(response.status, 200);
    const body = responseSchema.parse(await response.json());
    pages.push(body.posts.map((post) => post.id));
    if (!body.hasMore) return pages;
    assert.ok(body.cursor);
    cursor = body.cursor;
  }
  throw new Error('Profile pagination did not terminate');
}

async function createAuthor(prefix: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `${prefix}-${id}`,
    displayName: 'Post cursor fixture',
    updatedAt: new Date(),
  });
  ownedUsers.push(id);
  return id;
}

async function insertPosts(
  authorId: string,
  timestamps: Date[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const timestamp of timestamps) {
    const id = await generateSnowflakeId();
    await db.insert(posts).values({
      id,
      content: `post cursor fixture ${id}`,
      authorId,
      type: 'post',
      timestamp,
      createdAt: timestamp,
    });
    ids.push(id);
    ownedPosts.push(id);
  }
  return ids;
}

function nextCursor(page: PostPage): string | undefined {
  const last = page[page.length - 1];
  return last ? encodePostCursor(last.timestamp, last.id) : undefined;
}

/** Follows route cursors for one author until a page comes back short. */
async function collectActorPages(authorId: string, limit: number) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await service.getPostsByActor(authorId, limit, cursor);
    pages.push(page.map((p) => p.id));
    if (page.length < limit) break;
    cursor = nextCursor(page);
  }
  return pages;
}

function pastSecond(offsetSeconds: number): Date {
  return new Date(fixtureClock - offsetSeconds * 1000);
}

describe('post feed keyset cursor (real database)', () => {
  let equalAuthor: string;
  let equalIds: string[];
  let mixedAuthor: string;
  let mixedIds: string[];
  let microAuthor: string;
  let microIds: string[];

  beforeAll(async () => {
    const t = pastSecond(120);
    equalAuthor = await createAuthor('pce');
    equalIds = await insertPosts(equalAuthor, [t, t, t]);

    mixedAuthor = await createAuthor('pcm');
    const older = new Date(t.getTime() - 1000);
    mixedIds = await insertPosts(mixedAuthor, [t, t, older, older, older]);

    // Two posts in the same millisecond with different microseconds, plus
    // one exactly on the millisecond: only SQL can store these.
    microAuthor = await createAuthor('pcu');
    microIds = [];
    const base = pastSecond(180).toISOString().replace('T', ' ').slice(0, 23);
    for (const micros of ['', '400', '700']) {
      const id = await generateSnowflakeId();
      await db.execute(sql`
        INSERT INTO "Post" ("id", "content", "authorId", "type", "timestamp", "createdAt")
        VALUES (${id}, ${`post cursor fixture ${id}`}, ${microAuthor}, 'post',
                ${`${base}${micros}`}::timestamp, ${`${base}${micros}`}::timestamp)
      `);
      microIds.push(id);
      ownedPosts.push(id);
    }
  });

  it('follows actual HTTP cursors across equal-timestamp pages', async () => {
    const pages = await collectHttpPages(equalAuthor, 2);
    expect(pages[0]).toHaveLength(2);
    expect(pages.flat()).toEqual([...equalIds].sort().reverse());
  });

  it('preserves microsecond order through actual HTTP cursors', async () => {
    expect((await collectHttpPages(microAuthor, 1)).flat()).toEqual(
      [...microIds].reverse()
    );
  });

  it('returns every equal-timestamp post exactly once across pages', async () => {
    const pages = await collectActorPages(equalAuthor, 2);
    const all = pages.flat();
    expect(pages[0]).toHaveLength(2);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...equalIds].sort());
  });

  it('pages mixed timestamps newest first without gaps or repeats', async () => {
    const pages = await collectActorPages(mixedAuthor, 2);
    const all = pages.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...mixedIds].sort());
    // The two newer posts come before the three older ones.
    expect(all.slice(0, 2).sort()).toEqual(mixedIds.slice(0, 2).sort());
  });

  it('keeps sub-millisecond timestamps in order across pages', async () => {
    const pages = await collectActorPages(microAuthor, 1);
    const all = pages.flat();
    expect(new Set(all).size).toBe(3);
    // Newest (700 us) first, then 400 us, then the exact millisecond.
    expect(all).toEqual([...microIds].reverse());
  });

  it('still accepts a legacy timestamp-only cursor', async () => {
    const t = pastSecond(120);
    const page = await service.getPostsByActor(
      mixedAuthor,
      10,
      new Date(t.getTime() + 1).toISOString()
    );
    expect(page.map((p) => p.id).sort()).toEqual([...mixedIds].sort());

    const older = await service.getPostsByActor(
      mixedAuthor,
      10,
      t.toISOString()
    );
    expect(older.map((p) => p.id).sort()).toEqual(mixedIds.slice(2).sort());
  });

  it('falls back to the timestamp when the cursor post id is unknown', async () => {
    const t = pastSecond(120);
    const unknown = encodePostCursor(t, await generateSnowflakeId());
    const page = await service.getPostsByActor(mixedAuthor, 10, unknown);
    expect(page.map((p) => p.id).sort()).toEqual(mixedIds.slice(2).sort());
  });

  it('ignores a soft-deleted anchor and uses the cursor timestamp', async () => {
    const t = pastSecond(120);
    const author = await createAuthor('pcd');
    const [visible] = await insertPosts(author, [t]);
    const deletedId = await generateSnowflakeId();
    const deletedAt = new Date(t.getTime() - 5000);
    await db.insert(posts).values({
      id: deletedId,
      content: `post cursor fixture ${deletedId}`,
      authorId: author,
      type: 'post',
      timestamp: deletedAt,
      createdAt: deletedAt,
      deletedAt,
    });
    ownedPosts.push(deletedId);
    // Cursor claims a time above the visible post but names the deleted one.
    const claimed = new Date(t.getTime() + 1000);
    const legacy = await service.getPostsByActor(
      author,
      10,
      claimed.toISOString()
    );
    const anchored = await service.getPostsByActor(
      author,
      10,
      encodePostCursor(claimed, deletedId)
    );
    expect(legacy.map((p) => p.id)).toEqual([visible as string]);
    expect(anchored.map((p) => p.id)).toEqual([visible as string]);
  });

  it('ignores a future-dated anchor and uses the cursor timestamp', async () => {
    const t = pastSecond(120);
    const author = await createAuthor('pcf');
    const [newer, older] = await insertPosts(author, [
      t,
      new Date(t.getTime() - 2000),
    ]);
    const futureId = (
      await insertPosts(author, [new Date(Date.now() + 30 * 86_400_000)])
    )[0] as string;
    // Cursor claims a time between the two visible posts but names the
    // future post.
    const claimed = new Date(t.getTime() - 1000);
    const anchored = await service.getPostsByActor(
      author,
      10,
      encodePostCursor(claimed, futureId)
    );
    expect(anchored.map((p) => p.id)).toEqual([older as string]);
    expect(anchored.map((p) => p.id)).not.toContain(newer as string);
  });

  it('recent feed continues past equal-timestamp posts', async () => {
    const t = pastSecond(240);
    const author = await createAuthor('pcr');
    const ids = await insertPosts(author, [t, t, t]);
    // Enter the feed just above the fixture second, as a client holding an
    // older legacy cursor would.
    const page1 = await service.getRecentPosts(
      2,
      new Date(t.getTime() + 1).toISOString()
    );
    const ids1 = page1.map((p) => p.id);
    expect(ids1.every((id) => ids.includes(id))).toBe(true);

    const page2 = await service.getRecentPosts(2, nextCursor(page1));
    const reached = [
      ...ids1,
      ...page2.map((p) => p.id).filter((id) => ids.includes(id)),
    ];
    expect(new Set(reached).size).toBe(reached.length);
    expect([...reached].sort()).toEqual([...ids].sort());
  });
});
