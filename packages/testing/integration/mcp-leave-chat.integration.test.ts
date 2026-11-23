/**
 * MCP leave_chat must follow the same membership rules as
 * DELETE /api/chats/[id]/participants/me: a caller who is not a participant
 * is rejected, and a group owner cannot leave. The owner decision and both
 * writes commit together, with GroupMember locked before ChatParticipant.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { and, chatParticipants, chats, db, eq, groupMembers } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { executeLeaveChat } from '../../mcp/src/handlers/tool-handlers';
import { createStewardTestToken } from './helpers/steward-auth';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const target = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname) ||
  !/^\/(test_db|feed_pr\d+)$/.test(target.pathname) ||
  target.search ||
  target.hash ||
  (process.env.DIRECT_DATABASE_URL &&
    process.env.DIRECT_DATABASE_URL !== databaseUrl) ||
  process.env.DATABASE_READ_REPLICA_URL
)
  throw new Error('A disposable loopback primary database is required');
const control = postgres(databaseUrl, { max: 4 });
let main: LeaveFixture;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let groupId: string;
let chatId: string;
let dmChatId: string;

async function snapshotUserRows(userId: string) {
  const participants = await db
    .select({
      id: chatParticipants.id,
      chatId: chatParticipants.chatId,
      isActive: chatParticipants.isActive,
    })
    .from(chatParticipants)
    .where(eq(chatParticipants.userId, userId));
  const members = await db
    .select({
      id: groupMembers.id,
      groupId: groupMembers.groupId,
      isActive: groupMembers.isActive,
      role: groupMembers.role,
      kickReason: groupMembers.kickReason,
      kickedAt: groupMembers.kickedAt,
    })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  const byId = (left: { id: string }, right: { id: string }) =>
    left.id.localeCompare(right.id);
  return {
    participants: participants.sort(byId),
    members: members.sort(byId),
  };
}

describe('MCP leave_chat group owner policy', () => {
  beforeAll(async () => {
    main = await createLeavingMember();
    ({ ownerId, memberId, outsiderId, groupId, chatId, dmChatId } = main);
  });

  afterAll(async () => {
    const failures: Error[] = [];
    try {
      for (const fixture of fixtures) {
        try {
          await fixture.cleanup();
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    } finally {
      await control.end({ timeout: 5 });
      await db.$disconnect();
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Owned fixtures retained after cleanup refusal'
      );
  });

  it('refuses to let the group owner leave and keeps both memberships active', async () => {
    await expect(
      executeLeaveChat({ agentId: 'owner-agent', userId: ownerId }, { chatId })
    ).rejects.toThrow(
      'Group owners cannot leave. Transfer ownership or delete the group.'
    );

    const [ownerMembership] = await db
      .select({
        isActive: groupMembers.isActive,
        role: groupMembers.role,
      })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, ownerId))
      );
    const [ownerParticipant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, ownerId)
        )
      );

    expect(ownerMembership).toEqual({ isActive: true, role: 'owner' });
    expect(ownerParticipant?.isActive).toBe(true);
  });

  it('deactivates a non-owner member of the same group chat', async () => {
    const result = await executeLeaveChat(
      { agentId: 'member-agent', userId: memberId },
      { chatId }
    );
    await acceptLeave(main, main.membershipId, main.participantId);
    expect(result).toEqual({ success: true });

    const [membership] = await db
      .select({
        isActive: groupMembers.isActive,
        kickReason: groupMembers.kickReason,
      })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, memberId)
        )
      );
    const [participant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, memberId)
        )
      );

    expect(membership?.isActive).toBe(false);
    expect(membership?.kickReason).toBe('User left');
    expect(participant?.isActive).toBe(false);
  });

  it('still lets the owner leave a direct chat that has no group', async () => {
    const result = await executeLeaveChat(
      { agentId: 'owner-agent', userId: ownerId },
      { chatId: dmChatId }
    );
    await acceptParticipantLeave(main, main.dmParticipantId);
    expect(result).toEqual({ success: true });

    const [participant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, dmChatId),
          eq(chatParticipants.userId, ownerId)
        )
      );
    expect(participant?.isActive).toBe(false);
  });

  it('rejects an unknown chatId and does not write a membership', async () => {
    const unknownChatId = await generateSnowflakeId();
    const before = await snapshotUserRows(ownerId);

    await expect(
      executeLeaveChat(
        { agentId: 'owner-agent', userId: ownerId },
        { chatId: unknownChatId }
      )
    ).rejects.toThrow('You are not a member of this chat.');

    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, unknownChatId));
    const strayParticipants = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, unknownChatId));

    expect(chat).toBeUndefined();
    expect(strayParticipants).toEqual([]);
    expect(await snapshotUserRows(ownerId)).toEqual(before);
  });

  it('rejects a caller who is not a participant and leaves existing rows unchanged', async () => {
    const chatBefore = await snapshotUserRows(ownerId);
    const memberBefore = await snapshotUserRows(memberId);
    const outsiderBefore = await snapshotUserRows(outsiderId);

    await expect(
      executeLeaveChat(
        { agentId: 'outsider-agent', userId: outsiderId },
        { chatId }
      )
    ).rejects.toThrow('You are not a member of this chat.');

    expect(await snapshotUserRows(ownerId)).toEqual(chatBefore);
    expect(await snapshotUserRows(memberId)).toEqual(memberBefore);
    expect(await snapshotUserRows(outsiderId)).toEqual(outsiderBefore);
    expect(outsiderBefore.participants).toEqual([]);
    expect(outsiderBefore.members).toEqual([]);
  });

  it('rolls back the member write when the participant update is cancelled', async () => {
    const fixture = await createLeavingMember();
    const held = await holdRow(async (tx) => {
      await tx.unsafe(
        'SELECT id FROM "ChatParticipant" WHERE id = $1 FOR UPDATE',
        [fixture.participantId]
      );
    });
    const leave = executeLeaveChat(
      { agentId: 'member-agent', userId: fixture.memberId },
      { chatId: fixture.chatId }
    );
    const settled = settle(leave);
    try {
      const waiterPid = await waitForBlockedLeave({
        holderPid: held.holderPid,
        queryIncludes: 'update "ChatParticipant"',
        wroteGroupMember: true,
      });

      // The member update is in the same open transaction, so another
      // connection still sees the caller as an active member.
      expect(
        await readLeaveRows(fixture.membershipId, fixture.participantId)
      ).toEqual(activeMemberRows());

      const [backend] = await control<{ started: string }[]>`
        SELECT backend_start::text AS started FROM pg_stat_activity
        WHERE pid=${waiterPid} AND datname=current_database() AND usename=current_user
          AND ${held.holderPid}=ANY(pg_blocking_pids(pid))
          AND query LIKE '%update "ChatParticipant"%'
      `;
      if (!backend) throw new Error('Owned cancellation target changed');
      const [cancelled] = await control<{ pg_cancel_backend: boolean }[]>`
        SELECT pg_cancel_backend(pid) AS pg_cancel_backend FROM pg_stat_activity
        WHERE pid=${waiterPid} AND backend_start::text=${backend.started}
          AND datname=current_database() AND usename=current_user
          AND ${held.holderPid}=ANY(pg_blocking_pids(pid))
          AND query LIKE '%update "ChatParticipant"%'
      `;
      expect(cancelled?.pg_cancel_backend).toBe(true);

      const result = await settled;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errorText(result.error).toLowerCase()).toContain('cancel');
      }

      expect(
        await readLeaveRows(fixture.membershipId, fixture.participantId)
      ).toEqual(activeMemberRows());
    } finally {
      await held.release();
      await settled;
      await fixture.cleanup();
    }
  });

  it('rejects the leave when the caller becomes owner while the member row is locked', async () => {
    const fixture = await createLeavingMember();
    let decide!: (promote: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    let markReady!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      markReady = resolve;
    });
    let promoted: PhysicalReceipt | undefined;
    const finished = control.begin(async (tx) => {
      await tx.unsafe('SELECT id FROM "GroupMember" WHERE id = $1 FOR UPDATE', [
        fixture.membershipId,
      ]);
      const [row] = await tx.unsafe<postgres.Row[]>(
        'SELECT pg_backend_pid() AS pid'
      );
      markReady(Number(row?.pid));
      if (await decision) {
        const [row] = await tx.unsafe<PhysicalReceipt[]>(
          `UPDATE "GroupMember" SET role = 'owner' WHERE id = $1
           RETURNING id, to_jsonb("GroupMember")::text AS canonical`,
          [fixture.membershipId]
        );
        if (!row) throw new Error('Owned promotion did not return its row');
        promoted = row;
      }
    });
    const holderPid = await ready;
    const leave = executeLeaveChat(
      { agentId: 'member-agent', userId: fixture.memberId },
      { chatId: fixture.chatId }
    );
    const settled = settle(leave);
    try {
      await waitForBlockedLeave({
        holderPid,
        queryIncludes: 'for update',
      });
      expect(
        await readLeaveRows(fixture.membershipId, fixture.participantId)
      ).toEqual(activeMemberRows());

      decide(true);
      await finished;
      if (!promoted) throw new Error('Owned promotion receipt missing');
      replaceReceipt(fixture, 'GroupMember', promoted);

      const result = await settled;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errorText(result.error)).toContain(
          'Group owners cannot leave. Transfer ownership or delete the group.'
        );
      }
      expect(
        await readLeaveRows(fixture.membershipId, fixture.participantId)
      ).toEqual({
        member: { isActive: true, role: 'owner', kickReason: null },
        participant: { isActive: true },
      });
    } finally {
      decide(false);
      await finished.catch(() => undefined);
      await settled;
      await fixture.cleanup();
    }
  });
  it('rolls back partial setup and refuses to erase foreign fixture context', async () => {
    const fixture = await createLeavingMember();
    const before = await readPhysical(fixture);
    const attemptedUsers: string[] = [];
    await expect(
      createLeavingMember(fixture.groupId, attemptedUsers)
    ).rejects.toMatchObject({ code: '23505' });
    const remaining = await control.unsafe<{ id: string }[]>(
      'SELECT id FROM "User" WHERE id = ANY($1::text[])',
      [attemptedUsers]
    );
    expect(Array.from(remaining)).toEqual([]);
    expect(await readPhysical(fixture)).toEqual(before);

    const foreignId = await generateSnowflakeId();
    const [foreign] = await control.unsafe<PhysicalReceipt[]>(
      'INSERT INTO "ChatParticipant" (id,"chatId","userId") VALUES ($1,$2,$3) RETURNING id,to_jsonb("ChatParticipant")::text AS canonical',
      [foreignId, fixture.chatId, fixture.outsiderId]
    );
    if (!foreign) throw new Error('Foreign control receipt missing');
    try {
      await expect(fixture.cleanup()).rejects.toThrow(
        'Owned fixture cleanup refused'
      );
      expect(await readPhysical(fixture)).toEqual(before);
      const [retained] = await control.unsafe<PhysicalReceipt[]>(
        'SELECT id,to_jsonb("ChatParticipant")::text AS canonical FROM "ChatParticipant" WHERE id=$1',
        [foreign.id]
      );
      expect(retained).toEqual(foreign);
    } finally {
      const removed = await control.unsafe<{ id: string }[]>(
        'DELETE FROM "ChatParticipant" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING id',
        [foreign.id, foreign.canonical]
      );
      expect(removed).toHaveLength(1);
    }
    const original = fixture.rows.find(
      (row) => row.table === 'User' && row.id === fixture.ownerId
    );
    if (!original) throw new Error('Owned drift-control receipt missing');
    const [changed] = await control.unsafe<PhysicalReceipt[]>(
      'UPDATE "User" SET bio=$2 WHERE id=$1 AND to_jsonb("User")=$3::text::jsonb RETURNING id,to_jsonb("User")::text AS canonical',
      [original.id, 'separately acquired drift control', original.canonical]
    );
    if (!changed)
      throw new Error('Drift control did not acquire its exact change');
    try {
      await expect(fixture.cleanup()).rejects.toThrow(
        'Owned fixture cleanup refused User'
      );
      const after = await readPhysical(fixture);
      expect(after).toEqual(
        before.map((row) =>
          row.table === 'User' && row.id === changed.id
            ? { ...changed, table: 'User' }
            : row
        )
      );
    } finally {
      const [restored] = await control.unsafe<PhysicalReceipt[]>(
        'UPDATE "User" SET bio=($2::text::jsonb->>\'bio\') WHERE id=$1 AND to_jsonb("User")=$3::text::jsonb RETURNING id,to_jsonb("User")::text AS canonical',
        [original.id, original.canonical, changed.canonical]
      );
      expect(restored).toEqual({
        id: original.id,
        canonical: original.canonical,
      });
      await fixture.cleanup();
    }
  });

  it('serializes actual web and A2A leaves in member-before-participant order', async () => {
    const fixture = await createLeavingMember();
    const base = new URL(
      process.env.TEST_API_URL ||
        process.env.TEST_BASE_URL ||
        'http://127.0.0.1:3100'
    );
    if (
      !['127.0.0.1', 'localhost'].includes(base.hostname) ||
      base.protocol !== 'http:' ||
      base.username ||
      base.password
    )
      throw new Error('An owned loopback integration server is required');
    const token = await createStewardTestToken(`mcp-leave-${fixture.memberId}`);
    const key = `feed_leave_${randomUUID()}${randomUUID()}`;
    const keyId = await generateSnowflakeId();
    const [keyRow] = await control.unsafe<PhysicalReceipt[]>(
      'INSERT INTO "UserApiKey" (id,"userId","keyHash",name) VALUES ($1,$2,$3,$4) RETURNING id,to_jsonb("UserApiKey")::text AS canonical',
      [
        keyId,
        fixture.memberId,
        createHash('sha256').update(key).digest('hex'),
        'owned leave overlap',
      ]
    );
    if (!keyRow) throw new Error('Owned API key receipt missing');
    fixture.rows.push({ ...keyRow, table: 'UserApiKey' });
    const memberHeld = await holdRow(async (tx) => {
      await tx.unsafe('SELECT id FROM "GroupMember" WHERE id=$1 FOR UPDATE', [
        fixture.membershipId,
      ]);
    });
    const participantHeld = await holdRow(async (tx) => {
      await tx.unsafe(
        'SELECT id FROM "ChatParticipant" WHERE id=$1 FOR UPDATE',
        [fixture.participantId]
      );
    });
    let web: Promise<Response> | undefined;
    let a2a: Promise<Response> | undefined;
    let phase = 'web-member-lock';
    let primaryFailure: Error | undefined;
    try {
      web = fetch(
        new URL(`/api/chats/${fixture.chatId}/participants/me`, base),
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        }
      );
      const webPid = await waitForBlockedLeave({
        holderPid: memberHeld.holderPid,
        queryIncludes: 'update "GroupMember"',
      });
      a2a = fetch(new URL('/api/a2a', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: randomUUID(),
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    operation: 'messaging.leave_chat',
                    params: { chatId: fixture.chatId },
                  },
                },
              ],
            },
            configuration: { blocking: true },
          },
        }),
      });
      phase = 'a2a-first-lock';
      const first = await waitForFirstLeaveLock(
        memberHeld.holderPid,
        participantHeld.holderPid,
        webPid
      );
      await participantHeld.release();
      if (first.target === 'ChatParticipant') {
        phase = 'participant-first-member-lock';
        await waitForBlockedLeave({
          holderPid: memberHeld.holderPid,
          queryIncludes: 'update "GroupMember"',
          excludePid: webPid,
        });
      }
      await memberHeld.release();
      phase = 'http-responses';
      const [webResult, a2aResult] = await Promise.all([web, a2a]);
      const a2aPayload = z
        .object({
          jsonrpc: z.literal('2.0'),
          result: z.object({
            contextId: z.literal(fixture.memberId),
            status: z.object({
              state: z.literal('failed'),
              message: z.object({
                parts: z.array(
                  z.object({ kind: z.literal('text'), text: z.string() })
                ),
              }),
            }),
          }),
        })
        .parse(await a2aResult.json());
      console.log(
        'LEAVE_LOCK_ORDER_PROOF',
        JSON.stringify({
          firstA2AWait: first.target,
          observedAt: first.observedAt,
          a2aWaiterPid: first.pid,
          webWaiterPid: webPid,
          directBlockerPid: first.blockerPid,
          viaEarlierWebWaiter: first.blockerPid === webPid,
          webBlockedByOwnedMember: first.webBlockedByMember,
          ownedBarrierPid:
            first.target === 'GroupMember'
              ? memberHeld.holderPid
              : participantHeld.holderPid,
          webStatus: webResult.status,
          a2aStatus: a2aResult.status,
          a2aTaskState: a2aPayload.result.status.state,
        })
      );
      expect(webResult.status).toBe(200);
      expect(a2aResult.status).toBe(200);
      expect(
        a2aPayload.result.status.message.parts
          .map((part) => part.text)
          .join(' ')
      ).toContain('Chat not found or already left');
      phase = 'owned-effect-validation';
      await acceptLeave(
        fixture,
        fixture.membershipId,
        fixture.participantId,
        true
      );
      expect(first.target).toBe('GroupMember');
      expect(first.query.toLowerCase()).toContain('for update');
      const [member] = await control.unsafe<
        { active: boolean; role: string }[]
      >('SELECT "isActive" AS active,role FROM "GroupMember" WHERE id=$1', [
        fixture.membershipId,
      ]);
      expect(member).toEqual({ active: false, role: 'member' });
    } catch (error) {
      primaryFailure =
        error instanceof Error ? error : new Error(String(error));
      console.log(
        'LEAVE_LOCK_ORDER_HOLD',
        JSON.stringify({ phase, errorClass: primaryFailure.name })
      );
      throw primaryFailure;
    } finally {
      await participantHeld.release();
      await memberHeld.release();
      await Promise.allSettled([...(web ? [web] : []), ...(a2a ? [a2a] : [])]);
      try {
        await fixture.cleanup();
      } catch (cleanupError) {
        if (primaryFailure)
          throw new AggregateError(
            [primaryFailure, cleanupError],
            `Leave overlap failed during ${phase}; fixture retained`
          );
        throw cleanupError;
      }
    }
  });
});

type TransactionSql = postgres.TransactionSql;

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) parts.push(current.message);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' || typeof record.code === 'number') {
      parts.push(String(record.code));
    }
    current = record.cause;
  }
  return parts.length > 0 ? parts.join('\n') : String(error);
}

function activeMemberRows() {
  return {
    member: { isActive: true, role: 'member', kickReason: null },
    participant: { isActive: true },
  };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

function holdRow(lock: (tx: TransactionSql) => Promise<void>) {
  let releaseGate!: () => void;
  let markReady!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    markReady = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const finished = control.begin(async (tx) => {
    await lock(tx);
    const [row] = await tx.unsafe<postgres.Row[]>(
      'SELECT pg_backend_pid() AS pid'
    );
    markReady(Number(row?.pid));
    await released;
  });
  const acquired = Promise.race([
    ready,
    finished.then(() => {
      throw new Error('Owned lock holder exited before acquiring its row');
    }),
  ]);
  return acquired.then((holderPid) => ({
    holderPid,
    release: async () => {
      releaseGate();
      await finished;
    },
  }));
}

async function wroteGroupMember(pid: number): Promise<boolean> {
  // UPDATE takes RowExclusiveLock on the heap. SELECT FOR UPDATE takes only
  // RowShareLock, so this is the member write and not the earlier lock.
  const rows = await control<{ found: number }[]>`
    SELECT 1 AS found
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    WHERE l.pid = ${pid}
      AND l.granted
      AND l.mode = 'RowExclusiveLock'
      AND c.oid = 'public."GroupMember"'::regclass
    LIMIT 1
  `;
  return rows.length > 0;
}

async function lockSnapshot(): Promise<string> {
  const rows = await control<{ pid: number; query: string }[]>`
    SELECT a.pid, left(a.query, 180) AS query
    FROM pg_stat_activity a
    WHERE a.datname = current_database()
      AND a.pid <> pg_backend_pid()
  `;
  return JSON.stringify(rows);
}

async function waitForBlockedLeave(options: {
  holderPid: number;
  queryIncludes: string;
  wroteGroupMember?: boolean;
  excludePid?: number;
}): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const waiters = await control<{ pid: number; query: string }[]>`
      SELECT a.pid, a.query
      FROM pg_stat_activity a
      WHERE ${options.holderPid} = ANY (pg_blocking_pids(a.pid))
        AND a.datname=current_database() AND a.usename=current_user
    `;
    for (const waiter of waiters) {
      if (
        Number(waiter.pid) === options.excludePid ||
        !waiter.query.includes(options.queryIncludes)
      )
        continue;
      const pid = Number(waiter.pid);
      if (options.wroteGroupMember && !(await wroteGroupMember(pid))) continue;
      return pid;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Timed out waiting for leave query containing ${options.queryIncludes}. ${await lockSnapshot()}`
  );
}

async function readLeaveRows(membershipId: string, participantId: string) {
  const [member] = await db
    .select({
      isActive: groupMembers.isActive,
      role: groupMembers.role,
      kickReason: groupMembers.kickReason,
    })
    .from(groupMembers)
    .where(eq(groupMembers.id, membershipId));
  const [participant] = await db
    .select({ isActive: chatParticipants.isActive })
    .from(chatParticipants)
    .where(eq(chatParticipants.id, participantId));
  return { member, participant };
}

type OwnedTable =
  | 'User'
  | 'Group'
  | 'Chat'
  | 'GroupMember'
  | 'ChatParticipant'
  | 'UserApiKey';
type PhysicalReceipt = { id: string; canonical: string };
type OwnedReceipt = PhysicalReceipt & { table: OwnedTable };
type LeaveFixture = {
  ownerId: string;
  memberId: string;
  outsiderId: string;
  groupId: string;
  chatId: string;
  dmChatId: string;
  membershipId: string;
  participantId: string;
  dmParticipantId: string;
  rows: OwnedReceipt[];
  started: string;
  cleanup(): Promise<void>;
};
const fixtures: LeaveFixture[] = [];

async function createLeavingMember(
  existingGroupId?: string,
  attemptedUsers: string[] = []
): Promise<LeaveFixture> {
  const ids = await Promise.all(
    Array.from({ length: 11 }, () => generateSnowflakeId())
  );
  const [
    ownerId,
    memberId,
    outsiderId,
    proposedGroupId,
    chatId,
    dmChatId,
    ownerMembershipId,
    membershipId,
    ownerParticipantId,
    participantId,
    dmParticipantId,
  ] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const groupId = existingGroupId ?? proposedGroupId;
  const started = new Date().toISOString();
  const rows: OwnedReceipt[] = [];
  // No acquired ownership escapes a failed transaction, including a late PK collision.
  await control.begin(async (tx) => {
    async function acquire(
      table: OwnedTable,
      statement: string,
      args: string[]
    ) {
      const [row] = await tx.unsafe<PhysicalReceipt[]>(
        statement + ` RETURNING id,to_jsonb("${table}")::text AS canonical`,
        args
      );
      if (!row) throw new Error('Fixture INSERT did not return ownership');
      rows.push({ ...row, table });
    }
    for (const id of [ownerId, memberId, outsiderId]) {
      attemptedUsers.push(id);
      await acquire(
        'User',
        'INSERT INTO "User" (id,username,"stewardId","isActor","updatedAt") VALUES ($1,$2,$3,false,$4)',
        [id, `leave_${id}`, `mcp-leave-${id}`, started]
      );
    }
    await acquire(
      'Group',
      'INSERT INTO "Group" (id,name,type,"ownerId","createdById","updatedAt") VALUES ($1,$2,\'user\',$3,$3,$4)',
      [groupId, 'mcp leave owner group', ownerId, started]
    );
    await acquire(
      'Chat',
      'INSERT INTO "Chat" (id,"isGroup","groupId","createdBy","updatedAt") VALUES ($1,true,$2,$3,$4)',
      [chatId, groupId, ownerId, started]
    );
    await acquire(
      'Chat',
      'INSERT INTO "Chat" (id,"isGroup","createdBy","updatedAt") VALUES ($1,false,$2,$3)',
      [dmChatId, ownerId, started]
    );
    await acquire(
      'GroupMember',
      'INSERT INTO "GroupMember" (id,"groupId","userId",role,"addedBy") VALUES ($1,$2,$3,\'owner\',$3)',
      [ownerMembershipId, groupId, ownerId]
    );
    await acquire(
      'GroupMember',
      'INSERT INTO "GroupMember" (id,"groupId","userId",role,"addedBy") VALUES ($1,$2,$3,\'member\',$4)',
      [membershipId, groupId, memberId, ownerId]
    );
    for (const [id, targetChat, user] of [
      [ownerParticipantId, chatId, ownerId],
      [participantId, chatId, memberId],
      [dmParticipantId, dmChatId, ownerId],
    ]) {
      await acquire(
        'ChatParticipant',
        'INSERT INTO "ChatParticipant" (id,"chatId","userId") VALUES ($1,$2,$3)',
        [id!, targetChat!, user!]
      );
    }
  });
  const fixture: LeaveFixture = {
    ownerId,
    memberId,
    outsiderId,
    groupId,
    chatId,
    dmChatId,
    membershipId,
    participantId,
    dmParticipantId,
    rows,
    started,
    cleanup: () => cleanupFixture(fixture),
  };
  fixtures.push(fixture);
  return fixture;
}

function replaceReceipt(
  fixture: LeaveFixture,
  table: OwnedTable,
  row: PhysicalReceipt
) {
  const receipt = fixture.rows.find(
    (item) => item.table === table && item.id === row.id
  );
  if (!receipt) throw new Error('Cannot acquire an unowned row version');
  receipt.canonical = row.canonical;
}

async function acceptParticipantLeave(
  fixture: LeaveFixture,
  id: string,
  deleted = false
) {
  const receipt = fixture.rows.find(
    (row) => row.table === 'ChatParticipant' && row.id === id
  );
  if (!receipt) throw new Error('Participant ownership receipt missing');
  const [row] = await control.unsafe<PhysicalReceipt[]>(
    'SELECT id,to_jsonb(t)::text AS canonical FROM "ChatParticipant" t WHERE id=$1 AND (to_jsonb(t)-\'isActive\')=($2::text::jsonb-\'isActive\') AND NOT "isActive"',
    [id, receipt.canonical]
  );
  if (deleted) {
    const present = await control.unsafe(
      'SELECT id FROM "ChatParticipant" WHERE id=$1',
      [id]
    );
    if (present.length)
      throw new Error('Web leave did not remove its owned participant');
    fixture.rows = fixture.rows.filter((item) => item !== receipt);
  } else {
    if (!row) throw new Error('Participant leave changed an unapproved field');
    replaceReceipt(fixture, 'ChatParticipant', row);
  }
}

async function acceptLeave(
  fixture: LeaveFixture,
  membershipId: string,
  participantId: string,
  deleted = false
) {
  const receipt = fixture.rows.find(
    (row) => row.table === 'GroupMember' && row.id === membershipId
  );
  if (!receipt) throw new Error('Membership ownership receipt missing');
  const [row] = await control.unsafe<PhysicalReceipt[]>(
    `SELECT id,to_jsonb(t)::text AS canonical FROM "GroupMember" t WHERE id=$1
      AND (to_jsonb(t)-ARRAY['isActive','kickedAt','kickReason'])=($2::text::jsonb-ARRAY['isActive','kickedAt','kickReason'])
      AND NOT "isActive" AND "kickReason"='User left' AND "kickedAt">=$3::timestamp AND "kickedAt"<=clock_timestamp()`,
    [membershipId, receipt.canonical, fixture.started]
  );
  if (!row) throw new Error('Member leave changed an unapproved field');
  await acceptParticipantLeave(fixture, participantId, deleted);
  replaceReceipt(fixture, 'GroupMember', row);
}

async function readPhysical(fixture: LeaveFixture) {
  const result: OwnedReceipt[] = [];
  for (const row of fixture.rows) {
    const [current] = await control.unsafe<PhysicalReceipt[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Owned fixture row missing');
    result.push({ ...current, table: row.table });
  }
  return result;
}

const childGuards: Record<OwnedTable, string> = {
  UserApiKey: '',
  ChatParticipant: '',
  GroupMember: '',
  Chat: ' AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "MessageReaction" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "DMAcceptance" WHERE "chatId"=t.id)',
  Group:
    ' AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "parentGroupId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "createdBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "ownerId"=t.id OR "createdById"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "senderId"=t.id)',
};

async function cleanupFixture(fixture: LeaveFixture) {
  if (!fixture.rows.length) return;
  await control.begin(async (tx) => {
    for (const table of [
      'UserApiKey',
      'ChatParticipant',
      'Chat',
      'GroupMember',
      'Group',
      'User',
    ] as const) {
      for (const row of fixture.rows.filter((item) => item.table === table)) {
        // API key validation only schedules an exact-key lastUsedAt UPDATE.
        // A late update after DELETE affects zero rows, and no other drift is accepted.
        const match =
          table === 'UserApiKey'
            ? `(to_jsonb(t)-'lastUsedAt')=($2::text::jsonb-'lastUsedAt') AND ("lastUsedAt" IS NULL OR ("lastUsedAt">=$3::timestamp AND "lastUsedAt"<=clock_timestamp()))`
            : 'to_jsonb(t)=$2::text::jsonb';
        const args =
          table === 'UserApiKey'
            ? [row.id, row.canonical, fixture.started]
            : [row.id, row.canonical];
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}" t WHERE id=$1 AND ${match}${childGuards[table]} RETURNING id`,
          args
        );
        if (removed.length !== 1)
          throw new Error(`Owned fixture cleanup refused ${table}`);
      }
    }
  });
  fixture.rows = [];
}

async function waitForFirstLeaveLock(
  memberHolder: number,
  participantHolder: number,
  webPid: number
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await control<
      {
        pid: number;
        query: string;
        blockerPid: number;
        webBlockedByMember: boolean;
      }[]
    >`
      SELECT a.pid,a.query,blocker AS "blockerPid",
        EXISTS (
          SELECT 1 FROM pg_stat_activity web
          WHERE web.pid=${webPid} AND web.datname=current_database() AND web.usename=current_user
            AND web.query LIKE '%update "GroupMember"%'
            AND ${memberHolder}=ANY(pg_blocking_pids(web.pid))
        ) AS "webBlockedByMember"
      FROM pg_stat_activity a,
        LATERAL unnest(pg_blocking_pids(a.pid)) blocker
      WHERE a.datname=current_database() AND a.usename=current_user AND a.pid<>${webPid}
        AND blocker IN (${memberHolder},${participantHolder},${webPid})
    `;
    for (const row of rows) {
      if (
        row.query.includes('"GroupMember"') &&
        (row.blockerPid === memberHolder ||
          (row.blockerPid === webPid && row.webBlockedByMember))
      ) {
        // pg_blocking_pids can name an earlier waiter (soft block), so
        // validate both edges instead of treating the web PID as the holder.
        return {
          ...row,
          target: 'GroupMember' as const,
          observedAt: new Date().toISOString(),
        };
      }
      if (
        row.query.includes('"ChatParticipant"') &&
        row.blockerPid === participantHolder
      )
        return {
          ...row,
          target: 'ChatParticipant' as const,
          observedAt: new Date().toISOString(),
        };
    }
    await Bun.sleep(25);
  }
  throw new Error('Actual A2A leave did not reach either owned row lock');
}
