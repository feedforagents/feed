/**
 * The agent feed tools must apply the web feed's test-author rule:
 * DatabaseService.getRecentPosts (the HTTP home feed) excludes test
 * authors in SQL before paginating — accounts with the isTest flag and
 * accounts whose id starts with 'test-'. A2A social.get_feed and MCP
 * query_feed returned those posts, so agents read test content that
 * every human-facing list hides. Banned authors' posts are part of
 * the web feed's universe (no post-read path filters them) and must
 * keep appearing.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';
import { executeQueryFeed } from '../../mcp/src/handlers/tool-handlers';

const AUTHOR_MAIN = 'f27-vis-author-main';
const AUTHOR_TEST_FLAG = 'f27-vis-author-testflag';
const AUTHOR_TEST_PREFIX = 'test-f27-vis-author';
const AUTHOR_BANNED = 'f27-vis-author-banned';
const CALLER = 'f27-vis-caller';

const T0 = new Date(Date.now() - 60 * 60 * 1000);
T0.setMilliseconds(0);
const MIN = 60 * 1000;

const mainIds: string[] = [];
const bannedIds: string[] = [];
const testIds: string[] = [];
let deletedId: string;

async function insertUser(
  id: string,
  opts: { isTest?: boolean; isBanned?: boolean } = {}
) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    isTest: opts.isTest ?? false,
    isBanned: opts.isBanned ?? false,
    updatedAt: new Date(),
  });
}

async function insertPost(
  authorId: string,
  minutesAfterT0: number,
  opts: { deletedAt?: Date } = {}
) {
  const id = await generateSnowflakeId();
  const ts = new Date(T0.getTime() + minutesAfterT0 * MIN);
  await db.insert(posts).values({
    id,
    content: `f27 visibility post ${id}`,
    authorId,
    timestamp: ts,
    createdAt: ts,
    deletedAt: opts.deletedAt ?? null,
  });
  return id;
}

beforeAll(async () => {
  await insertUser(CALLER);
  await insertUser(AUTHOR_MAIN);
  await insertUser(AUTHOR_TEST_FLAG, { isTest: true });
  await insertUser(AUTHOR_TEST_PREFIX);
  await insertUser(AUTHOR_BANNED, { isBanned: true });

  for (let i = 1; i <= 3; i++) {
    mainIds.push(await insertPost(AUTHOR_MAIN, i));
  }
  bannedIds.push(await insertPost(AUTHOR_BANNED, 10));
  for (let i = 1; i <= 2; i++) {
    testIds.push(await insertPost(AUTHOR_TEST_FLAG, 20 + i));
    testIds.push(await insertPost(AUTHOR_TEST_PREFIX, 30 + i));
  }
  deletedId = await insertPost(AUTHOR_MAIN, 40, { deletedAt: new Date() });
});

afterAll(async () => {
  await db
    .delete(posts)
    .where(
      inArray(posts.id, [...mainIds, ...bannedIds, ...testIds, deletedId])
    );
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        CALLER,
        AUTHOR_MAIN,
        AUTHOR_TEST_FLAG,
        AUTHOR_TEST_PREFIX,
        AUTHOR_BANNED,
      ])
    );
});

function expectWebVisibility(label: string, got: string[]) {
  const gotSet = new Set(got);
  for (const id of mainIds) {
    expect(gotSet.has(id)).toBe(true);
  }
  for (const id of bannedIds) {
    expect(gotSet.has(id)).toBe(true);
  }
  for (const id of testIds) {
    expect(gotSet.has(id)).toBe(false);
  }
  expect(gotSet.has(deletedId)).toBe(false);
  console.log(`[F27] ${label}: visibility assertions evaluated`);
}

describe('agent feed tools apply the web test-author rule', () => {
  it('A2A social.get_feed excludes test authors', async () => {
    const result = (await FeedAgentExecutor.executeDirectly(
      'social.get_feed',
      { limit: 100 } as Record<string, JsonValue>,
      CALLER
    )) as { posts: Array<{ id: string }> };
    expectWebVisibility(
      'a2a get_feed',
      result.posts.map((p) => p.id)
    );
  });

  it('MCP query_feed excludes test authors', async () => {
    const result = await executeQueryFeed(
      { agentId: 'f27-vis-agent', userId: CALLER },
      { limit: 100 }
    );
    expectWebVisibility(
      'mcp query_feed',
      result.posts.map((p) => p.id)
    );
  });
});
