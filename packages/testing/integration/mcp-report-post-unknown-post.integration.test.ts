/**
 * MCP report_post must reject a target post that does not exist.
 *
 * The web report route (POST /api/moderation/reports) looks the reported
 * post up and answers NotFoundError before writing anything, and its
 * OpenAPI contract documents 404 "Reported user/post/comment not found".
 * executeReportPost writes the Report row unchecked instead: the table
 * has no foreign keys, so a report on an unknown post ID succeeds and a
 * status='pending' row lands in the admin moderation queue
 * (GET /api/admin/reports?status=pending) pointing at nothing.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  closeDatabase,
  db,
  eq,
  inArray,
  posts,
  reports,
  users,
} from '@feed/db';
import { executeReportPost } from '../../mcp/src/handlers/tool-handlers';

const GHOST_POST_ID = 'f182-ghost-report-00000000-0000-4000-8000-0000000000aa';

const userIds: string[] = [];
const postIds: string[] = [];
let agentUserId: string;
let authorId: string;
let realPostId: string;
let deletedPostId: string;

async function createUser(): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f182_${id.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  userIds.push(inserted[0].id);
  return inserted[0].id;
}

async function createPost(
  authorId: string,
  overrides: Partial<{ deletedAt: Date }> = {}
): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(posts)
    .values({
      id,
      content: 'f182 report target post',
      authorId,
      type: 'post',
      timestamp: new Date(),
      deletedAt: overrides.deletedAt ?? null,
    })
    .returning({ id: posts.id });
  if (!inserted[0]) throw new Error('Post fixture insert returned no row');
  postIds.push(inserted[0].id);
  return inserted[0].id;
}

async function reportRowsFor(postId: string) {
  return db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(eq(reports.reportedPostId, postId));
}

describe('MCP report_post target existence', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    authorId = await createUser();
    realPostId = await createPost(authorId);
    deletedPostId = await createPost(authorId, { deletedAt: new Date() });
    // Fixture sanity: the ghost ID must not be a real post.
    const ghosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, GHOST_POST_ID));
    expect(ghosts).toHaveLength(0);
  });

  afterAll(async () => {
    try {
      await db.delete(reports).where(eq(reports.reporterId, agentUserId));
      await db.delete(posts).where(inArray(posts.id, postIds));
      await db.delete(users).where(inArray(users.id, userIds));
      expect(await reportRowsFor(GHOST_POST_ID)).toHaveLength(0);
      expect(await reportRowsFor(realPostId)).toHaveLength(0);
      expect(await reportRowsFor(deletedPostId)).toHaveLength(0);
    } finally {
      await closeDatabase();
    }
  });

  it('rejects a report on an unknown post without writing a report row', async () => {
    await assert.rejects(
      executeReportPost(agent(), { postId: GHOST_POST_ID, reason: 'spam' }),
      /not found/
    );
    expect(await reportRowsFor(GHOST_POST_ID)).toHaveLength(0);
  });

  it('still reports a real post and queues it as pending', async () => {
    const result = await executeReportPost(agent(), {
      postId: realPostId,
      reason: 'spam',
    });
    expect(result.success).toBe(true);
    expect(result.reportId).toBeTruthy();
    const rows = await reportRowsFor(realPostId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(result.reportId);
    expect(rows[0]?.status).toBe('pending');
  });

  it('still accepts a soft-deleted post, matching the web report route', async () => {
    // Scope control: the web route checks existence only, so a post that
    // exists but is soft-deleted stays reportable on both surfaces.
    const result = await executeReportPost(agent(), {
      postId: deletedPostId,
      reason: 'spam',
    });
    expect(result.success).toBe(true);
    const rows = await reportRowsFor(deletedPostId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });
});
