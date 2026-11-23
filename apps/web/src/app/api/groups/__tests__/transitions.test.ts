import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

class TestApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

type FakeDb = Record<string, unknown>;
let fakeDb: FakeDb;
const messageColumns = {
  id: 'message.id',
  chatId: 'message.chatId',
  createdAt: 'message.createdAt',
};

mock.module('@feed/api', () => ({
  ApiError: TestApiError,
  authenticate: async () => ({ userId: 'user-1' }),
  checkProgress: async () => undefined,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({
  and: (...conditions: string[][]) => conditions,
  asUser: async (_user: unknown, callback: (db: FakeDb) => Promise<unknown>) =>
    callback(fakeDb),
  chatParticipants: {},
  desc: (column: string) => column,
  eq: (column: string, value: string) => [column, value],
  generateSnowflakeId: async () => 'id-1',
  groupMembers: {},
  messages: messageColumns,
  sql: () => undefined,
}));

mock.module('@feed/engine', () => ({
  StaticDataRegistry: { getActor: () => undefined },
}));

mock.module('@feed/shared', () => ({
  GROUP_CONFIG: { MAX_ACTIVE_USER_GROUPS: 10 },
  logger: { info: mock(), warn: mock(), error: mock() },
}));

const { POST: accept } = await import('../invites/[inviteId]/accept/route');
const { POST: decline } = await import('../invites/[inviteId]/decline/route');
const { POST: promote, DELETE: demote } = await import(
  '../[groupId]/admins/route'
);
const { GET: messages } = await import('../[groupId]/messages/route');

const pendingInvite = {
  id: 'invite-1',
  groupId: 'group-1',
  invitedUserId: 'user-1',
  invitedBy: 'owner-1',
  status: 'pending',
};

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

const inviteParams = { params: Promise.resolve({ inviteId: 'invite-1' }) };
const groupParams = { params: Promise.resolve({ groupId: 'group-1' }) };

describe('group invite transitions', () => {
  let insertCalled: boolean;
  let notificationUpdated: boolean;

  beforeEach(() => {
    insertCalled = false;
    notificationUpdated = false;
    fakeDb = {
      groupInvite: {
        findUnique: async () => pendingInvite,
        // Simulate a concurrent accept/decline that already claimed the row.
        updateMany: async () => ({ count: 0 }),
        update: async () => {
          throw new Error('unconditional update must not be used');
        },
      },
      group: { findUnique: async () => ({ type: 'user' }) },
      groupMember: { findFirst: async () => null },
      chat: { findFirst: async () => ({ id: 'chat-1' }) },
      insert: () => {
        insertCalled = true;
        return {
          values: () => ({ onConflictDoUpdate: async () => undefined }),
        };
      },
      notification: {
        updateMany: async () => {
          notificationUpdated = true;
          return { count: 1 };
        },
      },
    };
  });

  it('accept loses the race cleanly: no membership, no system message', async () => {
    await expect(
      accept(req('http://localhost/x', { method: 'POST' }), inviteParams)
    ).rejects.toMatchObject({ status: 400 });
    expect(insertCalled).toBe(false);
    expect(notificationUpdated).toBe(false);
  });

  it('decline loses the race cleanly', async () => {
    await expect(
      decline(req('http://localhost/x', { method: 'POST' }), inviteParams)
    ).rejects.toMatchObject({ status: 400 });
    expect(notificationUpdated).toBe(false);
  });
});

describe('group admin role transitions', () => {
  const roleUpdates: Array<{ where: Record<string, unknown> }> = [];

  beforeEach(() => {
    roleUpdates.length = 0;
    fakeDb = {
      groupMember: {
        findFirst: async ({ where }: { where: { userId: string } }) =>
          where.userId === 'user-1'
            ? { id: 'm-self', role: 'owner' }
            : { id: 'm-target', role: 'admin' },
        // The target's role changed concurrently (e.g. became owner).
        updateMany: async (args: { where: Record<string, unknown> }) => {
          roleUpdates.push(args);
          return { count: 0 };
        },
        update: async () => {
          throw new Error('unconditional update must not be used');
        },
      },
    };
  });

  it('demote is conditional on the target still being admin', async () => {
    await expect(
      demote(
        req('http://localhost/api/groups/group-1/admins?userId=target-1', {
          method: 'DELETE',
        }),
        groupParams
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(roleUpdates[0]?.where).toMatchObject({ role: 'admin' });
  });

  it('rejects blank user ids', async () => {
    await expect(
      promote(
        req('http://localhost/x', {
          method: 'POST',
          body: JSON.stringify({ userId: '   ' }),
        }),
        groupParams
      )
    ).rejects.toThrow();
    await expect(
      demote(
        req('http://localhost/api/groups/group-1/admins?userId=%20', {
          method: 'DELETE',
        }),
        groupParams
      )
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('group messages query', () => {
  const cursorWhere = mock((_conditions: string[][]) => ({
    limit: async () => [],
  }));
  const select = mock(() => ({ from: () => ({ where: cursorWhere }) }));

  beforeEach(() => {
    cursorWhere.mockClear();
    select.mockClear();
    fakeDb = {
      group: { findUnique: async () => ({ id: 'group-1', name: 'G' }) },
      groupMember: { findFirst: async () => ({ id: 'm-self' }) },
      chat: { findFirst: async () => ({ id: 'chat-1', name: 'G' }) },
      select,
      user: { findMany: async () => [] },
    };
  });

  it('rejects a non-numeric limit instead of querying with NaN', async () => {
    await expect(
      messages(req('http://localhost/x?limit=abc'), groupParams)
    ).rejects.toMatchObject({ status: 400 });
    expect(select).not.toHaveBeenCalled();
  });

  it('rejects a cursor that is not in this group chat', async () => {
    await expect(
      messages(req('http://localhost/x?cursor=other-chat-msg'), groupParams)
    ).rejects.toMatchObject({ status: 400, message: 'Invalid cursor' });
    expect(cursorWhere).toHaveBeenCalledWith([
      [messageColumns.id, 'other-chat-msg'],
      [messageColumns.chatId, 'chat-1'],
    ]);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('group PATCH validation', () => {
  it('rejects whitespace-only names and empty updates before any write', async () => {
    const { PATCH } = await import('../[groupId]/route');
    let updated = false;
    fakeDb = {
      groupMember: { findFirst: async () => ({ role: 'owner' }) },
      group: {
        update: async () => {
          updated = true;
          return {};
        },
      },
      chat: { updateMany: async () => ({ count: 0 }) },
    };

    for (const body of [{ name: '   ' }, {}]) {
      await expect(
        PATCH(
          req('http://localhost/x', {
            method: 'PATCH',
            body: JSON.stringify(body),
          }),
          groupParams
        )
      ).rejects.toThrow();
    }
    expect(updated).toBe(false);
  });
});
