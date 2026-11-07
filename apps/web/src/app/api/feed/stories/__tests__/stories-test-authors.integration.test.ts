/**
 * Integration test — Stories feed test-author exclusion
 *
 * @route GET /api/feed/stories
 *
 * Real-database test: the stories feed must apply the same test-author
 * exclusion as every sibling feed. The main feed excludes test authors in
 * SQL ("Exclude test authors in SQL before paginating, so pages are full";
 * DatabaseService.getRecentPosts), the following feed "Filters out posts
 * from test users" (CachedDatabaseService.getPostsForFollowing), an actor's
 * own post list returns empty for a test user
 * (DatabaseService.getPostsByActor), and the favorites feed applies the
 * same rule (#1670). A test author is one whose user row has isTest = true
 * or whose id starts with 'test-'. The stories pipeline applied neither
 * check in any of its candidate queries, so test posts filled the shared
 * stories snapshot every viewer receives.
 *
 * Pattern: stub only the `server-only` marker package; DB, cache fallback
 * and the route handler all run for real against PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, sql } from '@feed/db';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const NORMAL = 'f23-author-normal';
const TEST_FLAGGED = 'f23-author-testflag'; // user row with isTest = true
const TEST_PREFIXED = 'test-f23-actor'; // id starts with 'test-', no user row

const NORMAL_POST = 'f23-post-normal';
const TEST_FLAG_POST = 'f23-post-testflag';
const TEST_PREFIX_POST = 'f23-post-testprefix';
const Q_NORMAL_POST = 'f23-post-q-normal';
const Q_TEST_POST = 'f23-post-q-testflag';
const QUESTION_NUMBER = 923001;

const ALL_POSTS = [
  NORMAL_POST,
  TEST_FLAG_POST,
  TEST_PREFIX_POST,
  Q_NORMAL_POST,
  Q_TEST_POST,
];

async function insertFixtures() {
  await db.execute(sql`
    INSERT INTO "User" (id, username, "displayName", "updatedAt", "isTest")
    VALUES
      (${NORMAL}, 'f23normal', 'F23 Normal', NOW(), false),
      (${TEST_FLAGGED}, 'f23testflag', 'F23 Test Flag', NOW(), true)
  `);
  await db.execute(sql`
    INSERT INTO "Question"
      (id, "questionNumber", text, "scenarioId", outcome, rank, "resolutionDate", "updatedAt", status)
    VALUES
      ('f23-question-1', ${QUESTION_NUMBER}, 'F23 fixture question', 1, false, 1,
       NOW() + INTERVAL '7 days', NOW(), 'active')
  `);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp, type)
    VALUES
      (${NORMAL_POST}, 'f23 normal standalone post', ${NORMAL}, NOW() - INTERVAL '1 hour', 'post'),
      (${TEST_FLAG_POST}, 'f23 test-flagged standalone post', ${TEST_FLAGGED}, NOW() - INTERVAL '1 hour', 'post'),
      (${TEST_PREFIX_POST}, 'f23 test-prefixed standalone post', ${TEST_PREFIXED}, NOW() - INTERVAL '1 hour', 'post'),
      (${Q_NORMAL_POST}, 'f23 normal question post', ${NORMAL}, NOW() - INTERVAL '1 hour', 'post'),
      (${Q_TEST_POST}, 'f23 test-flagged question post', ${TEST_FLAGGED}, NOW() - INTERVAL '1 hour', 'post')
  `);
  await db.execute(sql`
    UPDATE "Post" SET "relatedQuestion" = ${QUESTION_NUMBER}
    WHERE id IN (${Q_NORMAL_POST}, ${Q_TEST_POST})
  `);
}

async function deleteFixtures() {
  await db.execute(sql`
    DELETE FROM "Post" WHERE id IN (${sql.join(
      ALL_POSTS.map((id) => sql`${id}`),
      sql`, `
    )})
  `);
  await db.execute(sql`DELETE FROM "Question" WHERE id = 'f23-question-1'`);
  await db.execute(sql`
    DELETE FROM "User" WHERE id IN (${NORMAL}, ${TEST_FLAGGED})
  `);
}

async function fetchStoryPostIds(): Promise<string[]> {
  const request = new NextRequest('https://feed.fun/api/feed/stories');
  const response = await GET(request);
  const body = (await response.json()) as {
    stories: Array<{ posts: Array<{ id: string }> }>;
  };
  return body.stories.flatMap((story) => story.posts.map((post) => post.id));
}

describe('GET /api/feed/stories test-author exclusion', () => {
  beforeAll(insertFixtures);
  afterAll(deleteFixtures);

  it('shows the normal author posts, standalone and question-linked', async () => {
    const postIds = await fetchStoryPostIds();
    expect(postIds).toContain(NORMAL_POST);
    expect(postIds).toContain(Q_NORMAL_POST);
  });

  it('hides posts by an isTest-flagged author', async () => {
    const postIds = await fetchStoryPostIds();
    expect(postIds).not.toContain(TEST_FLAG_POST);
    expect(postIds).not.toContain(Q_TEST_POST);
  });

  it('hides posts by a test- prefixed author', async () => {
    const postIds = await fetchStoryPostIds();
    expect(postIds).not.toContain(TEST_PREFIX_POST);
  });
});
