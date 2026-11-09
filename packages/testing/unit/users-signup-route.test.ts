/**
 * POST /api/users/signup — identity/profile write guarantees.
 *
 * Imports the real route handler with the DB transaction and side-effect
 * services faked, and asserts on the exact row patch written to `users`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const selectQueue: Row[][] = [];
const updatePayloads: Row[] = [];
const insertPayloads: Row[] = [];
let existingUserRecord: Row | null = null;

function chain(result: () => Row[]) {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: async () => result(),
  };
  return builder;
}

const fakeTx = {
  select: () => chain(() => selectQueue.shift() ?? []),
  update: () => ({
    set: (payload: Row) => {
      updatePayloads.push(payload);
      return {
        where: () => ({
          returning: async () => [{ ...existingUserRecord, ...payload }],
        }),
      };
    },
  }),
  insert: () => ({
    values: (payload: Row) => {
      insertPayloads.push(payload);
      const now = new Date('2026-01-01T00:00:00Z');
      return {
        returning: async () => [{ createdAt: now, ...payload }],
      };
    },
  }),
};

const awardTwitterLinkMock = mock(async () => ({ reputationAwarded: 0 }));
const trackServerEventMock = mock(async () => undefined);

const actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ...actualDb,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  withTransaction: <T>(fn: (tx: typeof fakeTx) => Promise<T>) => fn(fakeTx),
}));

const actualApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ...actualApi,
  authenticate: async () => ({
    userId: 'user-1',
    dbUserId: 'user-1',
    privyId: 'privy-1',
  }),
  cachedDb: { invalidateUserIdentifierCaches: async () => undefined },
  getHashedClientIp: () => null,
  isReferralCodeAvailableForUser: async () => true,
  notifyNewAccount: async () => undefined,
  ReputationService: {
    awardTwitterLink: awardTwitterLinkMock,
    awardProfileCompletion: async () => ({ reputationAwarded: 0 }),
    awardReferralSignup: async () => ({
      success: false,
      reputationAwarded: 0,
    }),
    awardReputation: async () => ({ reputationAwarded: 0 }),
  },
  TradingBalanceFundingService: {
    awardWelcomeBonus: async () => ({ success: true, alreadyProcessed: true }),
  },
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(request),
}));

const actualEngine = await import('@feed/engine');
mock.module('@feed/engine', () => ({
  ...actualEngine,
  UserAlphaGroupAssignmentService: {
    assignDefaultGroups: async () => ({
      groupsAssigned: 0,
      errors: [],
      assignments: [],
    }),
  },
}));

const posthogServerPath = new URL(
  '../../../apps/web/src/lib/posthog/server.ts',
  import.meta.url
).pathname;
mock.module(posthogServerPath, () => ({
  trackServerEvent: trackServerEventMock,
}));

const { POST } = await import(
  '../../../apps/web/src/app/api/users/signup/route'
);

function signupRequest(body: Row): NextRequest {
  return new NextRequest('https://feed.fun/api/users/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function queueExistingUser(record: Row) {
  existingUserRecord = record;
  selectQueue.push(
    [], // username uniqueness lookup
    [{ referredBy: null }], // existing referredBy lookup
    [record] // existing user record
  );
}

const baseExistingUser = {
  id: 'user-1',
  privyId: 'privy-1',
  email: 'owner@example.com',
  emailVerified: true,
  profileComplete: false,
  pointsAwardedForProfile: true,
  reputationPoints: 1500,
  referredBy: null,
  hasTwitter: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('POST /api/users/signup', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updatePayloads.length = 0;
    insertPayloads.length = 0;
    existingUserRecord = null;
    awardTwitterLinkMock.mockClear();
    trackServerEventMock.mockClear();
  });

  test('preserves an existing verified email (signup never writes email fields)', async () => {
    queueExistingUser(baseExistingUser);

    const response = await POST(
      signupRequest({
        username: 'alice',
        displayName: 'Alice',
        email: 'attacker@example.com',
      })
    );

    expect(response.status).toBe(200);
    expect(updatePayloads).toHaveLength(1);
    const patch = updatePayloads[0]!;
    expect('email' in patch).toBe(false);
    expect('emailVerified' in patch).toBe(false);
    expect('isAdmin' in patch).toBe(false);
  });

  test('client-supplied social import data never links an account or awards link reputation', async () => {
    queueExistingUser(baseExistingUser);

    await POST(
      signupRequest({
        username: 'alice',
        displayName: 'Alice',
        importedFrom: 'twitter',
        twitterId: '12345',
        twitterUsername: 'someone_else',
      })
    );

    const patch = updatePayloads[0]!;
    expect('hasTwitter' in patch).toBe(false);
    expect('twitterId' in patch).toBe(false);
    expect('twitterUsername' in patch).toBe(false);
    expect(awardTwitterLinkMock).not.toHaveBeenCalled();
  });

  test('waitlist starting balance applies only on first profile completion', async () => {
    queueExistingUser({ ...baseExistingUser, profileComplete: false });
    await POST(
      signupRequest({
        username: 'alice',
        displayName: 'Alice',
        isWaitlist: true,
      })
    );
    expect(updatePayloads[0]!.reputationPoints).toBe(100);

    updatePayloads.length = 0;
    queueExistingUser({ ...baseExistingUser, profileComplete: true });
    await POST(
      signupRequest({
        username: 'alice',
        displayName: 'Alice',
        isWaitlist: true,
      })
    );
    expect('reputationPoints' in updatePayloads[0]!).toBe(false);
  });

  test('returns the persisted Terms timestamp without inventing acceptance on profile completion', async () => {
    const acceptedAt = new Date('2026-02-03T04:05:06.000Z');
    for (const timestamp of [acceptedAt, null]) {
      queueExistingUser({ ...baseExistingUser, tosAcceptedAt: timestamp });
      const response = await POST(
        signupRequest({ username: 'alice', displayName: 'Alice' })
      );
      const body = (await response.json()) as {
        user: { tosAcceptedAt: string | null };
      };
      expect(body.user.tosAcceptedAt).toBe(timestamp?.toISOString() ?? null);
      expect('tosAcceptedAt' in updatePayloads.at(-1)!).toBe(false);
    }
  });

  test('new waitlist users are created with the waitlist starting balance', async () => {
    selectQueue.push([], [], []);

    await POST(
      signupRequest({ username: 'bob', displayName: 'Bob', isWaitlist: true })
    );

    expect(insertPayloads).toHaveLength(1);
    expect(insertPayloads[0]!.reputationPoints).toBe(100);
    expect('isAdmin' in insertPayloads[0]!).toBe(false);
    expect('email' in insertPayloads[0]!).toBe(false);
  });
});
