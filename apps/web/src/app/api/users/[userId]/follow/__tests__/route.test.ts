import { describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import { UserIdParamSchema } from '../../../../../../../../../packages/shared/src/validation/schemas/game';

const mockFindUserByIdentifier = mock();
const followLookups: unknown[] = [];

function selectQuery() {
  const query = {
    from: () => query,
    where: (condition: unknown) => {
      followLookups.push(condition);
      return query;
    },
    limit: async () => [{ id: 'follow-1' }],
  };
  return query;
}

mock.module('@feed/api', () => ({
  authenticate: async () => ({ userId: 'viewer-1' }),
  BusinessLogicError: Error,
  cachedDb: {},
  checkProgress: async () => undefined,
  checkRateLimitAndDuplicates: () => null,
  findUserByIdentifier: mockFindUserByIdentifier,
  InternalServerError: Error,
  NotFoundError: Error,
  notifyFollow: async () => undefined,
  RATE_LIMIT_CONFIGS: {},
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  db: { select: () => selectQuery() },
  eq: (column: unknown, value: unknown) => ({ column, value }),
  follows: {
    id: 'follows.id',
    followerId: 'followerId',
    followingId: 'followingId',
  },
  hasBlocked: mock(async () => false),
  userActorFollows: {},
  users: {},
  withTransaction: async () => undefined,
}));

mock.module('@feed/engine', () => ({
  StaticDataRegistry: { getActor: () => undefined },
}));

mock.module('@feed/shared', () => ({
  generateSnowflakeId: async () => 'id-1',
  logger: { info: mock(), warn: mock(), error: mock() },
  UserIdParamSchema,
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: async () => undefined,
}));

const { GET } = await import('../route');

describe('GET /api/users/[userId]/follow', () => {
  it('resolves usernames the same way POST/DELETE do', async () => {
    mockFindUserByIdentifier.mockResolvedValue({
      id: 'target-1',
      isActor: false,
    });

    const response = (await GET(
      new Request(
        'http://localhost/api/users/alice/follow'
      ) as unknown as NextRequest,
      { params: Promise.resolve({ userId: 'alice' }) }
    )) as Response;
    const body = (await response.json()) as { isFollowing: boolean };

    expect(mockFindUserByIdentifier).toHaveBeenCalledWith('alice', {
      id: true,
      isActor: true,
    });
    expect(body.isFollowing).toBe(true);
    expect(JSON.stringify(followLookups.at(-1))).toContain(
      '"value":"target-1"'
    );
  });
});
