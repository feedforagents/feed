/**
 * A2A social.get_feed must let an agent page through the whole feed:
 * the operation accepted only `limit` (clamped to 100) and silently
 * ignored `offset`, so every post past the newest 100 was unreachable
 * no matter what the agent sent. Sibling A2A list operations page with
 * offset/limit, and messaging.get_chats was fixed for the same shape.
 *
 * The fixture reproduces the tie conditions that broke sibling
 * surfaces: a large batch of posts sharing one timestamp (a single
 * multi-row insert, the way batched generation writes posts), so the
 * (timestamp, id) total order is required for pages to neither repeat
 * nor skip posts at tie boundaries.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

const AUTHOR = 'f27-page-author';
const CALLER = 'f27-page-caller';

const T0 = new Date(Date.now() - 2 * 60 * 60 * 1000);
T0.setMilliseconds(0);
const MIN = 60 * 1000;

const fixtureIds: string[] = [];

async function a2aFeed(params: Record<string, JsonValue>) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'social.get_feed',
    params,
    CALLER
  )) as { posts: Array<{ id: string; timestamp: string }> };
  return result.posts;
}

beforeAll(async () => {
  await db.insert(users).values([
    {
      id: CALLER,
      username: CALLER,
      displayName: CALLER,
      updatedAt: new Date(),
    },
    {
      id: AUTHOR,
      username: AUTHOR,
      displayName: AUTHOR,
      updatedAt: new Date(),
    },
  ]);

  // 30 newer posts at distinct times after the tie instant.
  for (let i = 1; i <= 30; i++) {
    const id = await generateSnowflakeId();
    fixtureIds.push(id);
    await db.insert(posts).values({
      id,
      content: `f27 paging newer ${id}`,
      authorId: AUTHOR,
      timestamp: new Date(T0.getTime() + i * MIN),
      createdAt: new Date(T0.getTime() + i * MIN),
      deletedAt: null,
    });
  }

  // 200 posts sharing exactly one timestamp — one multi-row insert.
  const tieValues: Array<{
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
    createdAt: Date;
    deletedAt: null;
  }> = [];
  for (let i = 0; i < 200; i++) {
    const id = await generateSnowflakeId();
    fixtureIds.push(id);
    tieValues.push({
      id,
      content: `f27 paging tie ${id}`,
      authorId: AUTHOR,
      timestamp: T0,
      createdAt: T0,
      deletedAt: null,
    });
  }
  await db.insert(posts).values(tieValues);

  // 20 older posts at distinct times before the tie instant.
  for (let i = 1; i <= 20; i++) {
    const id = await generateSnowflakeId();
    fixtureIds.push(id);
    await db.insert(posts).values({
      id,
      content: `f27 paging older ${id}`,
      authorId: AUTHOR,
      timestamp: new Date(T0.getTime() - i * MIN),
      createdAt: new Date(T0.getTime() - i * MIN),
      deletedAt: null,
    });
  }
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, fixtureIds));
  await db.delete(users).where(inArray(users.id, [CALLER, AUTHOR]));
});

describe('A2A social.get_feed pagination', () => {
  it('pages through the entire feed with offset, each post exactly once', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await a2aFeed({ limit: 100, offset });
      seen.push(...page.map((p) => p.id));
      if (page.length < 100) break;
    }
    const fixtureSeen = seen.filter((id) => fixtureIds.includes(id));
    expect(new Set(fixtureSeen).size).toBe(fixtureIds.length);
    expect(fixtureSeen.length).toBe(fixtureIds.length);
  });

  it('returns distinct pages for distinct offsets', async () => {
    const first = await a2aFeed({ limit: 10, offset: 0 });
    const second = await a2aFeed({ limit: 10, offset: 10 });
    const firstIds = new Set(first.map((p) => p.id));
    for (const p of second) {
      expect(firstIds.has(p.id)).toBe(false);
    }
  });

  it('keeps the default first page at 20 newest posts', async () => {
    const page = await a2aFeed({});
    expect(page.length).toBe(20);
    const fixtureInPage = page.filter((p) => fixtureIds.includes(p.id));
    expect(fixtureInPage.length).toBe(20);
  });
});
