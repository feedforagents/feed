/**
 * MCP leave_chat must follow the same membership rules as
 * DELETE /api/chats/[id]/participants/me: a caller who is not a participant
 * is rejected, and a group owner cannot leave. The owner decision and both
 * writes commit together, with GroupMember locked before ChatParticipant.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { executeLeaveChat } from '../../mcp/src/handlers/tool-handlers';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
const control = postgres(databaseUrl, { max: 4 });

const userIds: string[] = [];
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

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `leave_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

describe('MCP leave_chat group owner policy', () => {
  beforeAll(async () => {
    ownerId = await createUser();
    memberId = await createUser();
    outsiderId = await createUser();
    groupId = await generateSnowflakeId();
    chatId = await generateSnowflakeId();
    dmChatId = await generateSnowflakeId();

    await db.insert(groups).values({
      id: groupId,
      name: 'mcp leave owner group',
      type: 'user',
      ownerId,
      createdById: ownerId,
      updatedAt: new Date(),
    });
    await db.insert(chats).values([
      {
        id: chatId,
        isGroup: true,
        groupId,
        createdBy: ownerId,
        updatedAt: new Date(),
      },
      {
        id: dmChatId,
        isGroup: false,
        createdBy: ownerId,
        updatedAt: new Date(),
      },
    ]);
    await db.insert(groupMembers).values([
      {
        id: await generateSnowflakeId(),
        groupId,
        userId: ownerId,
        role: 'owner',
        addedBy: ownerId,
      },
      {
        id: await generateSnowflakeId(),
        groupId,
        userId: memberId,
        role: 'member',
        addedBy: ownerId,
      },
    ]);
    await db.insert(chatParticipants).values([
      {
        id: await generateSnowflakeId(),
        chatId,
        userId: ownerId,
      },
      {
        id: await generateSnowflakeId(),
        chatId,
        userId: memberId,
      },
      {
        id: await generateSnowflakeId(),
        chatId: dmChatId,
        userId: ownerId,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, [chatId, dmChatId]));
    await db.delete(chats).where(inArray(chats.id, [chatId, dmChatId]));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
    await db.delete(users).where(inArray(users.id, userIds));
    await control.end({ timeout: 5 });
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

      const [cancelled] = await control<{ pg_cancel_backend: boolean }[]>`
        SELECT pg_cancel_backend(${waiterPid}) AS pg_cancel_backend
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
    const finished = control.begin(async (tx) => {
      await tx.unsafe('SELECT id FROM "GroupMember" WHERE id = $1 FOR UPDATE', [
        fixture.membershipId,
      ]);
      const [row] = await tx.unsafe<postgres.Row[]>(
        'SELECT pg_backend_pid() AS pid'
      );
      markReady(Number(row?.pid));
      if (await decision) {
        await tx.unsafe(
          `UPDATE "GroupMember" SET role = 'owner' WHERE id = $1`,
          [fixture.membershipId]
        );
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
  return ready.then((holderPid) => ({
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
      AND c.relname = 'GroupMember'
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
}): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const waiters = await control<{ pid: number; query: string }[]>`
      SELECT a.pid, a.query
      FROM pg_stat_activity a
      WHERE ${options.holderPid} = ANY (pg_blocking_pids(a.pid))
    `;
    for (const waiter of waiters) {
      if (!waiter.query.includes(options.queryIncludes)) continue;
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

async function createLeavingMember() {
  const ownerId = await createUser();
  const memberId = await createUser();
  const groupId = await generateSnowflakeId();
  const chatId = await generateSnowflakeId();
  const membershipId = await generateSnowflakeId();
  const participantId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(groups).values({
    id: groupId,
    name: 'mcp leave atomic group',
    type: 'user',
    ownerId,
    createdById: ownerId,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: chatId,
    isGroup: true,
    groupId,
    createdBy: ownerId,
    updatedAt: now,
  });
  await db.insert(groupMembers).values([
    {
      id: await generateSnowflakeId(),
      groupId,
      userId: ownerId,
      role: 'owner',
      addedBy: ownerId,
    },
    {
      id: membershipId,
      groupId,
      userId: memberId,
      role: 'member',
      addedBy: ownerId,
    },
  ]);
  await db.insert(chatParticipants).values([
    {
      id: await generateSnowflakeId(),
      chatId,
      userId: ownerId,
    },
    {
      id: participantId,
      chatId,
      userId: memberId,
    },
  ]);

  return {
    memberId,
    chatId,
    membershipId,
    participantId,
    async cleanup() {
      await db
        .delete(chatParticipants)
        .where(eq(chatParticipants.chatId, chatId));
      await db.delete(chats).where(eq(chats.id, chatId));
      await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
      await db.delete(groups).where(eq(groups.id, groupId));
    },
  };
}
