import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({
    getAccessToken: mock(async () => 'test-token'),
  }),
}));

const {
  buildPredictionTradeHeaders,
  newPredictionTradeIdempotencyKey,
  usePredictionTrading,
} = await import('./usePredictionTrading');

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CapturedFetch = {
  url: string;
  init: RequestInit;
};

describe('newPredictionTradeIdempotencyKey', () => {
  it('returns a UUID v4 key', () => {
    expect(newPredictionTradeIdempotencyKey()).toMatch(UUID_V4);
  });

  it('returns a fresh key for each submission', () => {
    const first = newPredictionTradeIdempotencyKey();
    const second = newPredictionTradeIdempotencyKey();
    expect(second).not.toBe(first);
  });
});

describe('buildPredictionTradeHeaders', () => {
  it('carries the Idempotency-Key with the auth headers', () => {
    const key = newPredictionTradeIdempotencyKey();
    expect(buildPredictionTradeHeaders('token-123', key)).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-123',
      'Idempotency-Key': key,
    });
  });
});

describe('usePredictionTrading fetch', () => {
  const fetchCalls: CapturedFetch[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      const isSell = String(url).endsWith('/sell');
      return {
        ok: true,
        json: async () =>
          isSell
            ? { pnl: 5, remainingShares: 2 }
            : { position: { shares: 10, avgPrice: 0.5 } },
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function renderHook() {
    let captured: ReturnType<typeof usePredictionTrading> | undefined;
    function Probe() {
      captured = usePredictionTrading();
      return null;
    }
    renderToString(createElement(Probe));
    if (!captured) {
      throw new Error('usePredictionTrading did not render');
    }
    return captured;
  }

  function headerOf(call: CapturedFetch, name: string): string | undefined {
    const headers = call.init.headers as Record<string, string> | undefined;
    return headers?.[name];
  }

  it('sends an Idempotency-Key on buy', async () => {
    const hook = renderHook();
    await hook.buyPrediction({ marketId: 'm1', side: 'YES', amount: 100 });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('/api/markets/predictions/m1/buy');
    expect(headerOf(fetchCalls[0]!, 'Idempotency-Key')).toMatch(UUID_V4);
  });

  it('sends an Idempotency-Key on sell', async () => {
    const hook = renderHook();
    await hook.sellPrediction({
      marketId: 'm1',
      side: 'YES',
      shares: 5,
      positionId: 'p1',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('/api/markets/predictions/m1/sell');
    expect(headerOf(fetchCalls[0]!, 'Idempotency-Key')).toMatch(UUID_V4);
  });

  it('sends a fresh key for each new submission', async () => {
    const hook = renderHook();
    await hook.buyPrediction({ marketId: 'm1', side: 'YES', amount: 100 });
    await hook.buyPrediction({ marketId: 'm1', side: 'YES', amount: 100 });

    expect(fetchCalls).toHaveLength(2);
    const firstKey = headerOf(fetchCalls[0]!, 'Idempotency-Key');
    const secondKey = headerOf(fetchCalls[1]!, 'Idempotency-Key');
    expect(firstKey).toMatch(UUID_V4);
    expect(secondKey).toMatch(UUID_V4);
    expect(secondKey).not.toBe(firstKey);
  });

  it('refuses a second trade while one is in flight', async () => {
    const hook = renderHook();
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      await gate;
      return {
        ok: true,
        json: async () => ({ position: { shares: 10, avgPrice: 0.5 } }),
      } as Response;
    }) as typeof fetch;

    const first = hook.buyPrediction({
      marketId: 'm1',
      side: 'YES',
      amount: 100,
    });
    await expect(
      hook.buyPrediction({ marketId: 'm1', side: 'YES', amount: 100 })
    ).rejects.toThrow('already in progress');
    releaseFetch();
    await first;

    expect(fetchCalls).toHaveLength(1);
  });
});
