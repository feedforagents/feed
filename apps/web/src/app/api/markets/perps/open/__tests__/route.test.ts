import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import { PerpOpenPositionSchema } from '../../../../../../../../../packages/shared/src/validation/schemas/trade';

const actualShared = await import('@feed/shared');
const { withErrorHandling } = await import(
  '../../../../../../../../../packages/api/src/error-handler'
);
const { BadRequestError } = await import(
  '../../../../../../../../../packages/api/src/errors'
);

const mockOpenPosition = mock();
const mockCreateService = mock(() => ({ openPosition: mockOpenPosition }));

mock.module('@feed/api', () => ({
  authenticate: async () => ({ userId: 'user-1' }),
  BadRequestError,
  checkProgress: async () => undefined,
  checkRateLimitAsync: async () => ({ allowed: true }),
  invalidateMarketsApiPerpsSnapshot: async () => undefined,
  RATE_LIMIT_CONFIGS: { OPEN_POSITION: {} },
  rateLimitError: () => new Response(null, { status: 429 }),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling,
}));

mock.module('@feed/engine', () => ({
  handlePlayerTrade: async () => undefined,
}));

mock.module('@feed/shared', () => ({
  ...actualShared,
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

  it('preserves an omitted slippage bound for a market order', async () => {
    const response = (await POST(openRequest(marketOrder))) as Response;

    expect(response.status).toBe(201);
    expect(mockOpenPosition).toHaveBeenCalledWith({
      userId: 'user-1',
      ticker: 'ABC',
      side: 'long',
      size: 100,
      leverage: 5,
      maxSlippage: undefined,
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
    const response = await POST(
      openRequest({ ...marketOrder, orderType: 'limit', limitPrice: 95 })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Only market open orders are supported',
    });
    expect(mockOpenPosition).not.toHaveBeenCalled();
  });
  it('returns an actionable 400 when the domain rejects the slippage bound', async () => {
    mockOpenPosition.mockRejectedValueOnce(
      new actualShared.ValidationError('Slippage exceeded: max allowed 1.00%')
    );
    const response = await POST(
      openRequest({ ...marketOrder, maxSlippage: 0.01 })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('Slippage exceeded'),
    });
  });
});
