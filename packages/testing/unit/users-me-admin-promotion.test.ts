/**
 * GET /api/users/me — admin domain promotion requires a verified email.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

let storedUser: Row = {};
const updatePayloads: Row[] = [];

function selectChain() {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: async () => [storedUser],
  };
  return builder;
}

const fakeDb = {
  select: () => selectChain(),
  update: () => ({
    set: (payload: Row) => {
      updatePayloads.push(payload);
      return {
        where: () => ({
          returning: async () => [{ ...storedUser, ...payload }],
        }),
      };
    },
  }),
};

const actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({ ...actualDb, db: fakeDb }));

const actualApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ...actualApi,
  authenticate: async () => ({
    userId: 'user-1',
    dbUserId: 'user-1',
    privyId: 'privy-1',
  }),
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(request),
}));

const profileStatsPath = new URL(
  '../../../apps/web/src/lib/users/profile-stats.ts',
  import.meta.url
).pathname;
mock.module(profileStatsPath, () => ({
  getOptionalProfileStats: async () => null,
}));

const { GET } = await import('../../../apps/web/src/app/api/users/me/route');

const previousAdminDomain = process.env.ADMIN_EMAIL_DOMAIN;

function baseUser(overrides: Row): Row {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'user-1',
    privyId: 'privy-1',
    username: 'alice',
    email: 'alice@admin.example',
    emailVerified: false,
    profileComplete: true,
    referredBy: null,
    virtualBalance: '0',
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
    gameGuideCompletedAt: null,
    tosAcceptedAt: null,
    ...overrides,
  };
}

describe('GET /api/users/me admin promotion', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAIL_DOMAIN = 'admin.example';
    updatePayloads.length = 0;
  });

  afterAll(() => {
    if (previousAdminDomain === undefined) {
      delete process.env.ADMIN_EMAIL_DOMAIN;
    } else {
      process.env.ADMIN_EMAIL_DOMAIN = previousAdminDomain;
    }
  });

  test('an unverified email on the admin domain does not grant admin', async () => {
    storedUser = baseUser({ emailVerified: false });

    const response = await GET(
      new NextRequest('https://feed.fun/api/users/me')
    );
    const body = (await response.json()) as { user: { isAdmin: boolean } };

    expect(updatePayloads).toHaveLength(0);
    expect(body.user.isAdmin).toBe(false);
  });

  test('a verified email on the admin domain is promoted', async () => {
    storedUser = baseUser({ emailVerified: true });

    await GET(new NextRequest('https://feed.fun/api/users/me'));

    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]!.isAdmin).toBe(true);
  });

  test('returns persisted Terms acceptance and keeps absent acceptance null', async () => {
    const acceptedAt = new Date('2026-02-03T04:05:06.000Z');
    for (const timestamp of [acceptedAt, null]) {
      storedUser = baseUser({ tosAcceptedAt: timestamp });
      const response = await GET(
        new NextRequest('https://feed.fun/api/users/me')
      );
      const body = (await response.json()) as {
        user: { tosAcceptedAt: string | null };
      };
      expect(body.user.tosAcceptedAt).toBe(timestamp?.toISOString() ?? null);
    }
    expect(updatePayloads).toHaveLength(0);
  });

  test('existing admins are left untouched', async () => {
    storedUser = baseUser({ isAdmin: true, emailVerified: false });

    const response = await GET(
      new NextRequest('https://feed.fun/api/users/me')
    );
    const body = (await response.json()) as { user: { isAdmin: boolean } };

    expect(updatePayloads).toHaveLength(0);
    expect(body.user.isAdmin).toBe(true);
  });
});
