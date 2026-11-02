import { expect, test } from 'bun:test';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import { FEE_CONFIG } from '../../engine/src/config/fees';

// The A2A executor builds its own PredictionMarketService. Every other
// construction site (web trade routes, MCP handlers, agent executors) wires
// the fee fields from FEE_CONFIG, the centralized fee configuration. The
// A2A builder must charge the same fees: a trade must not cost 10x more
// because it arrived over A2A instead of the web API.
test('A2A prediction service is wired with the canonical FEE_CONFIG fees', () => {
  const executor = new FeedAgentExecutor();
  const service = (
    executor as unknown as {
      buildPredictionService: () => unknown;
    }
  ).buildPredictionService();
  const fees = (
    service as unknown as {
      deps: {
        fees: {
          tradingFeeRate: number;
          platformShare: number;
          referrerShare: number;
          minFeeAmount: number;
        };
      };
    }
  ).deps.fees;

  expect(fees.tradingFeeRate).toBe(FEE_CONFIG.TRADING_FEE_RATE);
  expect(fees.platformShare).toBe(FEE_CONFIG.PLATFORM_SHARE);
  expect(fees.referrerShare).toBe(FEE_CONFIG.REFERRER_SHARE);
  expect(fees.minFeeAmount).toBe(FEE_CONFIG.MIN_FEE_AMOUNT);
});
