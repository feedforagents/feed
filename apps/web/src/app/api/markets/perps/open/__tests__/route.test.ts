import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import { PerpOpenPositionSchema } from '../../../../../../../../../packages/shared/src/validation/schemas/trade';

class TestBadRequestError extends Error {
  readonly statusCode = 400;
}

const mockOpenPosition = mock();
const mockCreateService = mock(() => ({ openPosition: mockOpenPosition }));

mock.module('@feed/api', () => ({
  authenticate: async () => ({ userId: 'user-1' }),
  BadRequestError: TestBadRequestError,
  checkProgress: async () => undefined,
  checkRateLimitAsync: async () => ({ allowed: true }),
  invalidateMarketsApiPerpsSnapshot: async () => undefined,
  RATE_LIMIT_CONFIGS: { OPEN_POSITION: {} },
  rateLimitError: () => new Response(null, { status: 429 }),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/engine', () => ({
  handlePlayerTrade: async () => undefined,
}));

mock.module('@feed/shared', () => ({
  PerpOpenPositionSchema,
  fireAndForgetWithRetry: () => undefined,
  logger: { info: mock(), warn: mock(), error: mock() },
}));

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: async () => undefined,
}));

mock.module('../../_adapters', () => ({
  createPerpMarketService: mockCreateService,
}));

const { POST } = await import('../route');

function openRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/markets/perps/open', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const marketOrder = { ticker: 'ABC', side: 'long', size: 100, leverage: 5 };

describe('POST /api/markets/perps/open', () => {
  beforeEach(() => {
    mockOpenPosition.mockReset();
    mockOpenPosition.mockResolvedValue({
      positionId: 'pos-1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 5,
      entryPrice: 100,
      liquidationPrice: 80,
      marginPaid: 20,
      feePaid: 0.1,
      balance: 100,
    });
  });

  it('opens a market order with the 1% default slippage bound when none is given', async () => {
    const response = (await POST(openRequest(marketOrder))) as Response;

    expect(response.status).toBe(201);
    expect(mockOpenPosition).toHaveBeenCalledWith({
      userId: 'user-1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 5,
      maxSlippage: 0.01,
    });
  });

  it('lets a caller disable the slippage bound with 0', async () => {
    await POST(openRequest({ ...marketOrder, maxSlippage: 0 }));

    expect(mockOpenPosition).toHaveBeenCalledWith(
      expect.objectContaining({ maxSlippage: 0 })
    );
  });

  it('passes the requested maxSlippage through to the service', async () => {
    await POST(openRequest({ ...marketOrder, maxSlippage: 0.02 }));

    expect(mockOpenPosition).toHaveBeenCalledWith(
      expect.objectContaining({ maxSlippage: 0.02 })
    );
  });

  it('rejects limit open orders instead of executing at market', async () => {
    await expect(
      POST(openRequest({ ...marketOrder, orderType: 'limit', limitPrice: 95 }))
    ).rejects.toBeInstanceOf(TestBadRequestError);
    expect(mockOpenPosition).not.toHaveBeenCalled();
  });
});
