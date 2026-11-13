import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAuthenticate = mock();
const mockAsUser = mock();
const mockGetBlockedUserIds = mock();
const mockGetMutedUserIds = mock();
const mockGetBlockedByUserIds = mock();

mock.module('@feed/api', () => ({
  authenticate: mockAuthenticate,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({
  asUser: mockAsUser,
  getBlockedUserIds: mockGetBlockedUserIds,
  getMutedUserIds: mockGetMutedUserIds,
  getBlockedByUserIds: mockGetBlockedByUserIds,
}));

import { GET } from '../route';

describe('GET /api/chats/unread-count', () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
    mockAsUser.mockReset();
    mockGetBlockedUserIds.mockReset();
    mockGetMutedUserIds.mockReset();
    mockGetBlockedByUserIds.mockReset();
    mockGetBlockedUserIds.mockResolvedValue([]);
    mockGetMutedUserIds.mockResolvedValue([]);
    mockGetBlockedByUserIds.mockResolvedValue([]);
  });

  it('returns separate pending request and unread message counts', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockAsUser.mockImplementation(
      async (
        user: { userId: string },
        callback: (db: {
          dmAcceptance: { count: (input: unknown) => Promise<number> };
          notification: { count: (input: unknown) => Promise<number> };
        }) => Promise<unknown>
      ) =>
        callback({
          dmAcceptance: {
            count: async () => 2,
          },
          notification: {
            count: async () => 3,
          },
        })
    );

    const response = (await GET({} as never)) as Response;
    const body = await response.json();

    expect(body).toEqual({
      pendingDMs: 5,
      pendingDMRequests: 2,
      unreadMessages: 3,
      hasNewMessages: true,
    });
  });

  it('excludes blocked, muted and blocking actors from the unread count', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockGetBlockedUserIds.mockResolvedValue(['blocked-1']);
    mockGetMutedUserIds.mockResolvedValue(['muted-1', 'blocked-1']);
    mockGetBlockedByUserIds.mockResolvedValue(['blocker-1']);

    let capturedWhere: unknown;
    mockAsUser.mockImplementation(
      async (
        user: { userId: string },
        callback: (db: {
          dmAcceptance: { count: (input: unknown) => Promise<number> };
          notification: { count: (input: unknown) => Promise<number> };
        }) => Promise<unknown>
      ) =>
        callback({
          dmAcceptance: {
            count: async () => 0,
          },
          notification: {
            count: async (input: { where: unknown }) => {
              capturedWhere = input.where;
              return 1;
            },
          },
        })
    );

    const response = (await GET({} as never)) as Response;
    const body = await response.json();

    expect(body.unreadMessages).toBe(1);
    expect(capturedWhere).toEqual({
      userId: 'user-1',
      read: false,
      chatId: { not: null },
      OR: [
        { actorId: null },
        { actorId: { notIn: ['blocked-1', 'muted-1', 'blocker-1'] } },
      ],
    });
  });
});
