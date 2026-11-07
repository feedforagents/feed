import { describe, expect, it, mock } from 'bun:test';

mock.module('@feed/api', () => ({
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { POST } from './route';

describe('POST /api/users/trading-balance/transfer', () => {
  it('returns 410 with an explicit disabled message', async () => {
    const response = (await POST(
      new Request(
        'https://example.com/api/users/trading-balance/transfer'
      ) as unknown as import('next/server').NextRequest
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.code).toBe('TRADING_BALANCE_TRANSFER_DISABLED');
    expect(body.error).toContain(
      'Trading balance transfers are no longer supported'
    );
  });
});
