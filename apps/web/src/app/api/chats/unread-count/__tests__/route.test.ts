import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticate = mock();
const mockAsUser = mock();
const mockBlocks = mock();
const mockMutes = mock();
const mockPendingCount = mock();
const mockUnreadCount = mock();

mock.module('@feed/api', () => ({
  authenticate: mockAuthenticate,
  successResponse: (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (request: never) => Promise<Response>) =>
    handler,
}));
// Deliberately expose no global moderation helpers: all reads use asUser's DB.
mock.module('@feed/db', () => ({ asUser: mockAsUser }));

import { GET } from '../route';

type FixtureDb = {
  dmAcceptance: { count: typeof mockPendingCount };
  notification: { count: typeof mockUnreadCount };
  userBlock: { findMany: typeof mockBlocks };
  userMute: { findMany: typeof mockMutes };
};

describe('GET /api/chats/unread-count', () => {
  beforeEach(() => {
    for (const fn of [
      mockAuthenticate,
      mockAsUser,
      mockBlocks,
      mockMutes,
      mockPendingCount,
      mockUnreadCount,
    ])
      fn.mockReset();
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockBlocks.mockResolvedValue([]);
    mockMutes.mockResolvedValue([]);
    mockPendingCount.mockResolvedValue(2);
    mockUnreadCount.mockResolvedValue(3);
    mockAsUser.mockImplementation(
      async (
        _user: { userId: string },
        callback: (db: FixtureDb) => Promise<object>
      ) =>
        callback({
          dmAcceptance: { count: mockPendingCount },
          notification: { count: mockUnreadCount },
          userBlock: { findMany: mockBlocks },
          userMute: { findMany: mockMutes },
        })
    );
  });

  it('returns separate pending request and unread message counts', async () => {
    const response = await GET({} as never);
    expect(await response.json()).toEqual({
      pendingDMs: 5,
      pendingDMRequests: 2,
      unreadMessages: 3,
      hasNewMessages: true,
    });
    expect(mockAsUser.mock.calls[0]?.[0]).toEqual({ userId: 'user-1' });
    expect(mockPendingCount).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'pending' },
    });
    expect(mockUnreadCount).toHaveBeenCalledWith({
      where: { userId: 'user-1', read: false, chatId: { not: null } },
    });
  });

  it('excludes blocked, muted and blocking actors from the unread count', async () => {
    mockBlocks
      .mockResolvedValueOnce([{ blockedId: 'blocked-1' }])
      .mockResolvedValueOnce([{ blockerId: 'blocker-1' }]);
    mockMutes.mockResolvedValue([
      { mutedId: 'muted-1' },
      { mutedId: 'blocked-1' },
    ]);
    mockPendingCount.mockResolvedValue(0);
    mockUnreadCount.mockResolvedValue(1);
    const response = await GET({} as never);
    expect((await response.json()).unreadMessages).toBe(1);
    expect(mockBlocks).toHaveBeenCalledWith({
      where: { blockerId: 'user-1' },
      select: { blockedId: true },
    });
    expect(mockBlocks).toHaveBeenCalledWith({
      where: { blockedId: 'user-1' },
      select: { blockerId: true },
    });
    expect(mockMutes).toHaveBeenCalledWith({
      where: { muterId: 'user-1' },
      select: { mutedId: true },
    });
    expect(mockUnreadCount).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        read: false,
        chatId: { not: null },
        OR: [
          { actorId: null },
          { actorId: { notIn: ['blocked-1', 'muted-1', 'blocker-1'] } },
        ],
      },
    });
  });

  it('propagates moderation read failure instead of counting unfiltered notifications', async () => {
    mockBlocks.mockRejectedValueOnce(new Error('owned moderation read failed'));
    const response = await GET(
      new NextRequest('http://localhost/api/chats/unread-count')
    );
    expect(response.status).toBe(500);
    expect(mockUnreadCount).not.toHaveBeenCalled();
  });
});
