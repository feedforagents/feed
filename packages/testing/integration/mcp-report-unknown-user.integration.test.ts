/**
 * MCP report_user must reject a target user that does not exist, and a
 * self-report.
 *
 * The web report route (POST /api/moderation/reports) rejects a
 * self-report ("Cannot report yourself"), looks the reported user up and
 * answers 404 "Reported user/post/comment not found" (its OpenAPI
 * contract) before writing anything. executeReportUser writes
 * the Report row unchecked instead: the table has no foreign keys, so a
 * report of an unknown ID succeeds and the phantom report lands in the
 * admin moderation queue (GET /api/admin/reports lists Report rows with
 * a LEFT JOIN on the reported user) as a pending entry whose reported
 * user has a null username.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { and, closeDatabase, db, eq, inArray, reports, users } from '@feed/db';
import { executeReportUser } from '../../mcp/src/handlers/tool-handlers';

const GHOST_USER_ID = 'f181-ghost-report-00000000-0000-4000-8000-0000000000aa';

const userIds: string[] = [];
let agentUserId: string;
let realUserId: string;

async function createUser(): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f181_${id.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  userIds.push(inserted[0].id);
  return inserted[0].id;
}

async function reportRowsFor(targetId: string) {
  return db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(eq(reports.reportedUserId, targetId));
}

async function pendingQueueForReporter() {
  return db
    .select({ id: reports.id, reportedUserId: reports.reportedUserId })
    .from(reports)
    .where(
      and(eq(reports.reporterId, agentUserId), eq(reports.status, 'pending'))
    );
}

describe('MCP report_user target existence', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    realUserId = await createUser();
    // Fixture sanity: the ghost ID must not be a real user.
    const ghosts = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, GHOST_USER_ID));
    expect(ghosts).toHaveLength(0);
  });

  afterAll(async () => {
    try {
      await db.delete(reports).where(eq(reports.reporterId, agentUserId));
      await db.delete(users).where(inArray(users.id, userIds));
      expect(await reportRowsFor(GHOST_USER_ID)).toHaveLength(0);
      expect(await reportRowsFor(realUserId)).toHaveLength(0);
    } finally {
      await closeDatabase();
    }
  });

  it('rejects a report on an unknown user without writing a report row', async () => {
    await assert.rejects(
      executeReportUser(agent(), { userId: GHOST_USER_ID, reason: 'spam' }),
      /not found/
    );
    expect(await reportRowsFor(GHOST_USER_ID)).toHaveLength(0);
    expect(await pendingQueueForReporter()).toHaveLength(0);
  });

  it('rejects a self-report without writing a report row', async () => {
    await assert.rejects(
      executeReportUser(agent(), { userId: agentUserId, reason: 'spam' }),
      /Cannot report yourself/
    );
    expect(await reportRowsFor(agentUserId)).toHaveLength(0);
    expect(await pendingQueueForReporter()).toHaveLength(0);
  });

  it('reports a real user and the report enters the pending queue', async () => {
    const result = await executeReportUser(agent(), {
      userId: realUserId,
      reason: 'spam',
    });
    expect(result.success).toBe(true);
    const rows = await reportRowsFor(realUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(result.reportId);
    expect(rows[0]?.status).toBe('pending');

    const queue = await pendingQueueForReporter();
    expect(queue.map((r) => r.id)).toContain(result.reportId);
  });
});
