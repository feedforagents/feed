/**
 * Integration test — Web tag page (posts-by-tag) test-author exclusion
 *
 * @surface GET /api/trending/[tag] -> @feed/engine getPostsByTag
 *
 * Real-database test: the web tag page must apply the same test-author
 * exclusion as every sibling feed. The main feed excludes test authors in
 * SQL ("Exclude test authors in SQL before paginating, so pages are full";
 * DatabaseService.getRecentPosts), an actor's own post list returns empty
 * for a test user (DatabaseService.getPostsByActor), the following feed
 * "Filters out posts from test users" (CachedDatabaseService), and the
 * favorites (#1670) and stories (#1673) feeds apply the same rule. A test
 * author is one whose user row has isTest = true or whose id starts with
 * 'test-'. getPostsByTag excluded soft-deleted and future-dated posts but
 * applied neither test-author check, so test posts appeared on the public
 * tag page and inflated its total.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { db, sql } from '@feed/db';
import { getPostsByTag } from '../../services/tag-service';

const NORMAL = 'g4-author-normal';
const TEST_FLAGGED = 'g4-author-testflag'; // user row with isTest = true
const TEST_PREFIXED = 'test-g4-actor'; // id starts with 'test-', no user row

const TAG_NAME = 'g4tag';

const NORMAL_POST = 'g4-post-normal';
const TEST_FLAG_POST = 'g4-post-testflag';
const TEST_PREFIX_POST = 'g4-post-testprefix';
const FUTURE_POST = 'g4-post-future';
const DELETED_POST = 'g4-post-deleted';

const ALL_POSTS = [
  NORMAL_POST,
  TEST_FLAG_POST,
  TEST_PREFIX_POST,
  FUTURE_POST,
  DELETED_POST,
];

async function insertFixtures() {
  await db.execute(sql`
    INSERT INTO "User" (id, username, "displayName", "updatedAt", "isTest")
    VALUES
      (${NORMAL}, 'g4normal', 'G4 Normal', NOW(), false),
      (${TEST_FLAGGED}, 'g4testflag', 'G4 Test Flag', NOW(), true)
  `);
  await db.execute(sql`
    INSERT INTO "Tag" (id, name, "displayName", category, "updatedAt")
    VALUES ('g4-tag-1', ${TAG_NAME}, 'G4 Tag', 'test', NOW())
  `);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp, type, "deletedAt")
    VALUES
      (${NORMAL_POST}, 'g4 normal post', ${NORMAL}, NOW() - INTERVAL '1 hour', 'post', NULL),
      (${TEST_FLAG_POST}, 'g4 test-flagged post', ${TEST_FLAGGED}, NOW() - INTERVAL '1 hour', 'post', NULL),
      (${TEST_PREFIX_POST}, 'g4 test-prefixed post', ${TEST_PREFIXED}, NOW() - INTERVAL '1 hour', 'post', NULL),
      (${FUTURE_POST}, 'g4 future post', ${NORMAL}, NOW() + INTERVAL '1 day', 'post', NULL),
      (${DELETED_POST}, 'g4 deleted post', ${NORMAL}, NOW() - INTERVAL '1 hour', 'post', NOW())
  `);
  await db.execute(sql`
    INSERT INTO "PostTag" (id, "postId", "tagId")
    VALUES
      ('g4-pt-1', ${NORMAL_POST}, 'g4-tag-1'),
      ('g4-pt-2', ${TEST_FLAG_POST}, 'g4-tag-1'),
      ('g4-pt-3', ${TEST_PREFIX_POST}, 'g4-tag-1'),
      ('g4-pt-4', ${FUTURE_POST}, 'g4-tag-1'),
      ('g4-pt-5', ${DELETED_POST}, 'g4-tag-1')
  `);
}

async function deleteFixtures() {
  await db.execute(sql`
    DELETE FROM "PostTag" WHERE "tagId" = 'g4-tag-1'
  `);
  await db.execute(sql`
    DELETE FROM "Post" WHERE id IN (${sql.join(
      ALL_POSTS.map((id) => sql`${id}`),
      sql`, `
    )})
  `);
  await db.execute(sql`DELETE FROM "Tag" WHERE id = 'g4-tag-1'`);
  await db.execute(sql`
    DELETE FROM "User" WHERE id IN (${NORMAL}, ${TEST_FLAGGED})
  `);
}

describe('getPostsByTag (web tag page) visibility rules', () => {
  beforeAll(insertFixtures);
  afterAll(deleteFixtures);

  it('shows the normal author post', async () => {
    const result = await getPostsByTag(TAG_NAME, { limit: 20, offset: 0 });
    expect(result.posts.map((p) => p.id)).toContain(NORMAL_POST);
  });

  it('hides posts by an isTest-flagged author', async () => {
    const result = await getPostsByTag(TAG_NAME, { limit: 20, offset: 0 });
    expect(result.posts.map((p) => p.id)).not.toContain(TEST_FLAG_POST);
  });

  it('hides posts by a test- prefixed author with no user row', async () => {
    const result = await getPostsByTag(TAG_NAME, { limit: 20, offset: 0 });
    expect(result.posts.map((p) => p.id)).not.toContain(TEST_PREFIX_POST);
  });

  it('still hides future-dated and soft-deleted posts (controls)', async () => {
    const result = await getPostsByTag(TAG_NAME, { limit: 20, offset: 0 });
    const ids = result.posts.map((p) => p.id);
    expect(ids).not.toContain(FUTURE_POST);
    expect(ids).not.toContain(DELETED_POST);
  });

  it('counts only visible posts in the total', async () => {
    const result = await getPostsByTag(TAG_NAME, { limit: 20, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.posts.length).toBe(1);
  });
});
