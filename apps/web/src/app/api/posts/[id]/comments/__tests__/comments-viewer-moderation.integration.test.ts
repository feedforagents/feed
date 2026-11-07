/**
 * Integration test — Post comment thread viewer moderation filter
 *
 * @route GET /api/posts/[id]/comments
 *
 * Real-database test: the threaded comment list must apply the same viewer
 * moderation policy as every sibling read surface (main/following feed,
 * favorites feed, for-you/stories, web notifications, user search): comments
 * by authors the viewer has blocked or muted — or who have blocked the
 * viewer — are not returned. Anonymous reads stay unfiltered.
 *
 * Pattern: stub only the `server-only` marker package; DB, auth and the
 * route handler all run for real against PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, sql } from '@feed/db';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../route';

// This route resolves the viewer through optionalAuth, which only accepts
// a Steward JWT (the x-dev-user-id bypass belongs to authenticate()).
// Mint one against the dev secret for the fixture viewer.
const STEWARD_SECRET = 'f15-test-steward-secret';
process.env.STEWARD_JWT_SECRET = STEWARD_SECRET;

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: 'f15-steward-viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(STEWARD_SECRET));
  return { authorization: `Bearer ${token}` };
}

const POST_AUTHOR = '900000000000000201';
const VIEWER = '900000000000000202';
const NORMAL = '900000000000000203';
const BLOCKED = '900000000000000204'; // viewer blocked this author
const MUTED = '900000000000000205'; // viewer muted this author
const BLOCKER = '900000000000000206'; // this author blocked the viewer

const POST_ID = 'f15-post-1';

async function insertFixtures() {
  const userIds = [POST_AUTHOR, VIEWER, NORMAL, BLOCKED, MUTED, BLOCKER];
  for (const id of userIds) {
    await db.execute(sql`
      INSERT INTO "User" (id, username, "displayName", "updatedAt")
      VALUES (${id}, ${'f15user' + id.slice(-3)}, ${'F15 User ' + id.slice(-3)}, now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  await db.execute(sql`
    UPDATE "User" SET "stewardId" = 'f15-steward-viewer' WHERE id = ${VIEWER}
  `);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp)
    VALUES (${POST_ID}, 'f15 post for comment thread moderation', ${POST_AUTHOR}, now() - interval '1 hour')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "Comment" (id, content, "postId", "authorId", "parentCommentId", "updatedAt", "deletedAt")
    VALUES
      ('f15-c-normal', 'normal top-level', ${POST_ID}, ${NORMAL}, NULL, now(), NULL),
      ('f15-c-blocked', 'blocked author top-level', ${POST_ID}, ${BLOCKED}, NULL, now(), NULL),
      ('f15-c-muted', 'muted author top-level', ${POST_ID}, ${MUTED}, NULL, now(), NULL),
      ('f15-c-blocker', 'blocking author top-level', ${POST_ID}, ${BLOCKER}, NULL, now(), NULL),
      ('f15-c-own', 'viewer own comment', ${POST_ID}, ${VIEWER}, NULL, now(), NULL),
      ('f15-c-reply-normal', 'reply under normal', ${POST_ID}, ${POST_AUTHOR}, 'f15-c-normal', now(), NULL),
      ('f15-c-reply-to-blocked', 'reply under blocked root', ${POST_ID}, ${NORMAL}, 'f15-c-blocked', now(), NULL)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "UserBlock" (id, "blockerId", "blockedId")
    VALUES
      ('f15-block-1', ${VIEWER}, ${BLOCKED}),
      ('f15-block-2', ${BLOCKER}, ${VIEWER})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "UserMute" (id, "muterId", "mutedId")
    VALUES ('f15-mute-1', ${VIEWER}, ${MUTED})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanupFixtures() {
  await db.execute(sql`DELETE FROM "UserBlock" WHERE id LIKE 'f15-%'`);
  await db.execute(sql`DELETE FROM "UserMute" WHERE id LIKE 'f15-%'`);
  await db.execute(sql`DELETE FROM "Comment" WHERE id LIKE 'f15-%'`);
  await db.execute(sql`DELETE FROM "Post" WHERE id LIKE 'f15-%'`);
  await db.execute(sql`DELETE FROM "User" WHERE id LIKE '9000000000000002%'`);
}

type CommentNode = { id: string; replies: CommentNode[] };

function collectIds(nodes: CommentNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    ids.push(...collectIds(node.replies ?? []));
  }
  return ids;
}

async function fetchThread(headers?: Record<string, string>) {
  const request = new NextRequest(
    `http://localhost/api/posts/${POST_ID}/comments`,
    { headers }
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: POST_ID }),
  });
  const body = (await response.json()) as {
    data: { comments: CommentNode[]; total: number };
  };
  return body.data;
}

describe('GET /api/posts/[id]/comments viewer moderation', () => {
  beforeAll(insertFixtures);
  afterAll(cleanupFixtures);

  it('returns every visible comment to an anonymous reader (control)', async () => {
    const data = await fetchThread();
    const ids = collectIds(data.comments).sort();
    expect(ids).toEqual(
      [
        'f15-c-normal',
        'f15-c-blocked',
        'f15-c-muted',
        'f15-c-blocker',
        'f15-c-own',
        'f15-c-reply-normal',
        'f15-c-reply-to-blocked',
      ].sort()
    );
    expect(data.total).toBe(7);
  });

  it('hides blocked, muted and blocking authors from the signed-in viewer', async () => {
    const data = await fetchThread(await viewerAuthHeaders());
    const ids = collectIds(data.comments).sort();
    // The blocked author's whole subtree goes with its root, matching the
    // tree rule for comments whose parent is not visible.
    expect(ids).toEqual(
      ['f15-c-normal', 'f15-c-reply-normal', 'f15-c-own'].sort()
    );
    // total counts the rows that pass the viewer's visibility filter: the
    // three displayed comments plus the normal author's reply under the
    // blocked root — a visible row the tree cannot reach, counted exactly
    // as replies under soft-deleted parents already are on the base route.
    expect(data.total).toBe(4);
  });
});
