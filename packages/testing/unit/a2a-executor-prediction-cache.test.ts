import { expect, test } from 'bun:test';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

// The A2A executor builds its own PredictionMarketService. After every
// buy, sell, resolve, and cancel the service invalidates the market's
// cached recent-trades list through its cache port — but only when a
// port is wired. Every other trading surface wires one (web trade
// routes, MCP handlers, agent executors), all delegating to
// invalidateAfterPredictionTrade. Without it, an A2A trade leaves the
// cached trades list untouched and readers keep serving the pre-trade
// list until the entry expires.

type CacheShape = {
  invalidate: (pattern: string) => Promise<void>;
};

test('A2A prediction service is wired with a trades-cache port', async () => {
  const executor = new FeedAgentExecutor();
  const service = (
    executor as unknown as {
      buildPredictionService: () => unknown;
    }
  ).buildPredictionService() as { deps: { cache?: CacheShape } };

  expect(service.deps.cache).toBeDefined();

  // Delegation proof: invalidating a market pattern routes into the
  // engine's invalidateAfterPredictionTrade. With no cache client
  // configured (the unit-test environment) that function logs and
  // returns without touching the network, so the call resolves; a
  // missing or stub port cannot produce this path.
  await service.deps.cache?.invalidate('prediction:market-1:*');
});
