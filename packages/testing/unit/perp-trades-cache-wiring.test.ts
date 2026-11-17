import { expect, test } from 'bun:test';
import {
  createPerpTradesCachePort,
  setCacheInvalidationClient,
} from '../../engine/src/services/trade-cache-invalidation';

// The perp trades list served by GET /api/markets/perps/trades/[ticker]
// is cached for 30s. It is refreshed after a trade only if three links
// all exist: PerpMarketService calls its cache port (covered by
// PerpTradesCacheInvalidation.test.ts in @feed/core), every trading
// construction wires the shared port from createPerpTradesCachePort,
// and the engine invalidation helper has a client (wired in the web
// app's instrumentation). This test pins the shared port's delegation
// into the helper's client pattern-for-pattern.

test('perp cache port delegates the ticker to the invalidation client', async () => {
  const deleted: string[] = [];
  setCacheInvalidationClient({
    deleteByPattern: async (pattern: string) => {
      deleted.push(pattern);
      return 1;
    },
  });

  const port = createPerpTradesCachePort();
  await port.invalidate('perp:ABC:*');

  // The perp trades route caches under
  // 'market-trades:perp-trades:<lowercase ticker>:<limit>:<offset>'.
  expect(deleted).toEqual(['market-trades:perp-trades:abc:*']);
});
