import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

type UserRow = {
  id: string;
  isBanned: boolean;
  appealCount: number;
  appealStaked: boolean;
  appealStatus: string | null;
  appealStakeAmount: string | null;
  appealStakeTxHash: string | null;
  bannedAt: Date | null;
  bannedReason: string | null;
  falsePositiveHistory: null;
};

const mockAuthenticate = mock();
const mockCallClaude = mock();
const mockCreateNotification = mock(async () => undefined);
const mockUserFindUnique = mock();
const mockUserFindFirst = mock(async () => null);
const mockUserUpdate = mock(async () => ({}));
const mockEscrowFindUnique = mock();
const mockCredit = mock(async () => undefined);

mock.module('@feed/api', () => ({
  authenticate: mockAuthenticate,
  callClaudeDirect: mockCallClaude,
  createNotification: mockCreateNotification,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({
  db: {
    user: {
      findUnique: mockUserFindUnique,
      findFirst: mockUserFindFirst,
      update: mockUserUpdate,
    },
    moderationEscrow: { findUnique: mockEscrowFindUnique },
    report: { findMany: async () => [] },
    post: { findMany: async () => [] },
    message: { findMany: async () => [] },
  },
}));

mock.module('@feed/engine', () => ({
  WalletService: { credit: mockCredit },
}));

mock.module('@feed/shared', () => ({
  logger: { info: mock(), warn: mock(), error: mock() },
  MIN_APPEAL_STAKE_USD: 10,
}));

const { POST } = await import('../route');

const TX_HASH = `0x${'a'.repeat(64)}`;

let currentUser: UserRow;

function bannedUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    isBanned: true,
    appealCount: 0,
    appealStaked: false,
    appealStatus: null,
    appealStakeAmount: null,
    appealStakeTxHash: null,
    bannedAt: new Date(),
    bannedReason: 'reported',
    falsePositiveHistory: null,
    ...overrides,
  };
}

function appealRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/moderation/appeal', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function restoredAccount(): boolean {
  return mockUserUpdate.mock.calls.some((call) => {
    const arg = (call as unknown as [{ data: { isBanned?: boolean } }])[0];
    return arg.data.isBanned === false;
  });
}

describe('POST /api/moderation/appeal', () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
    mockCallClaude.mockReset();
    mockUserFindUnique.mockReset();
    mockUserUpdate.mockClear();
    mockUserFindFirst.mockClear();
    mockEscrowFindUnique.mockReset();
    mockCredit.mockClear();
    mockCreateNotification.mockClear();
    mockAuthenticate.mockResolvedValue({
      userId: 'user-1',
      dbUserId: 'user-1',
    });
    currentUser = bannedUser();
    mockUserFindUnique.mockImplementation(async () => currentUser);
    mockUserUpdate.mockImplementation(
      async (args: { data: Partial<UserRow> }) => {
        currentUser = { ...currentUser, ...args.data };
        return currentUser;
      }
    );
  });

  it('accepts a paid second review after the free appeal was used', async () => {
    currentUser = bannedUser({ appealCount: 1, appealStatus: 'denied' });
    mockEscrowFindUnique.mockResolvedValue({
      recipientId: 'user-1',
      status: 'paid',
      refundTxHash: null,
      amountUSD: 10,
    });
    mockCallClaude.mockResolvedValue(
      '{"shouldDeny": true, "reasoning": "clear evidence"}'
    );

    const response = (await POST(
      appealRequest({
        reason: 'This ban was a mistake, please review',
        stakeTxHash: TX_HASH,
      })
    )) as Response;
    const body = (await response.json()) as { status: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe('human_review');
    expect(currentUser.appealStakeTxHash).toBe(TX_HASH);
  });

  it('rejects a stake that is not a verified escrow payment without mutating', async () => {
    mockEscrowFindUnique.mockResolvedValue(null);

    const response = (await POST(
      appealRequest({
        reason: 'This ban was a mistake, please review',
        stakeTxHash: TX_HASH,
      })
    )) as Response;

    expect(response.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it('rejects malformed transaction hashes', async () => {
    await expect(
      POST(
        appealRequest({
          reason: 'This ban was a mistake, please review',
          stakeTxHash: 'not-a-hash',
        })
      )
    ).rejects.toThrow();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when the lenient evaluator omits shouldDeny', async () => {
    currentUser = bannedUser({
      appealStaked: true,
      appealStakeAmount: '10',
      appealStakeTxHash: TX_HASH,
      appealCount: 1,
    });
    mockCallClaude.mockResolvedValue('{"reasoning": "looks fine"}');

    await expect(
      POST(appealRequest({ reason: 'This ban was a mistake, please review' }))
    ).rejects.toThrow('invalid result');
    expect(restoredAccount()).toBe(false);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('fails closed when the strict evaluator returns a non-boolean', async () => {
    mockCallClaude.mockResolvedValue(
      '{"isFalsePositive": "false", "reasoning": "not a false positive"}'
    );

    await expect(
      POST(appealRequest({ reason: 'This ban was a mistake, please review' }))
    ).rejects.toThrow('invalid result');
    expect(restoredAccount()).toBe(false);
  });

  it('refunds once with the stake tx as relatedId and keeps the tx recorded', async () => {
    currentUser = bannedUser({
      appealStaked: true,
      appealStakeAmount: '10',
      appealStakeTxHash: TX_HASH,
      appealCount: 1,
    });
    mockCallClaude.mockResolvedValue(
      '{"shouldDeny": false, "reasoning": "benefit of the doubt"}'
    );

    const response = (await POST(
      appealRequest({ reason: 'This ban was a mistake, please review' })
    )) as Response;

    expect(response.status).toBe(200);
    expect(restoredAccount()).toBe(true);
    expect(mockCredit).toHaveBeenCalledTimes(1);
    expect(mockCredit.mock.calls[0]).toEqual([
      'user-1',
      10,
      'appeal_stake_refund',
      'Appeal stake refund - account restored',
      TX_HASH,
    ]);
    expect(currentUser.appealStaked).toBe(false);
    expect(currentUser.appealStakeTxHash).toBe(TX_HASH);
  });
});
