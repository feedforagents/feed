import { expect, test } from 'bun:test';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

// The A2A executor builds its own PredictionMarketService (via
// withPredictionSettlement + predictionServiceOptions) and
// PerpMarketService. Both services charge the trading fee inside their
// trade math, but the fee is only settled — recorded in tradingFees,
// the referrer share paid out, the trader's totalFeesPaid updated —
// when a feeProcessor dep is wired. Every other trading surface wires
// one (web trade routes, MCP handlers, agent executors; the autonomous
// executors omit it only for NPC trades, whose actor is the system).
// A2A trades are user trades, so the A2A-built services must carry the
// same processor: without it the fee is charged and then vanishes.
// (Rebased onto post-#1603 staging: the old buildPredictionService
// builder is gone, so the prediction side is now verified through
// predictionServiceOptions, whose feeProcessor factory is tx-aware
// like MCP's.)

type FeeProcessorShape = {
  processTradingFee: (params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
  }) => Promise<{ feeCharged: number; referrerPaid?: number }>;
};

function builtFeeProcessor(
  build: () => unknown
): FeeProcessorShape | undefined {
  const service = build() as { deps: { feeProcessor?: FeeProcessorShape } };
  return service.deps.feeProcessor;
}

test('A2A prediction service is wired with a fee processor', async () => {
  const executor = new FeedAgentExecutor();
  const options = (
    executor as unknown as {
      predictionServiceOptions: () => {
        feeProcessor?: () => FeeProcessorShape;
      };
    }
  ).predictionServiceOptions();
  const feeProcessor = options.feeProcessor?.();

  expect(feeProcessor).toBeDefined();

  // Delegation proof: a zero-amount fee is below the minimum, so the
  // real FeeService settles it as a no-op and returns before any
  // database access. A stub or missing processor cannot produce this.
  const result = await feeProcessor?.processTradingFee({
    userId: 'user-1',
    amount: 0,
    type: 'pred_buy',
    relatedId: 'market-1',
    positionId: 'position-1',
  });
  expect(result?.feeCharged).toBe(0);
  expect(result?.referrerPaid).toBe(0);
});

test('A2A perp service is wired with a fee processor', async () => {
  const executor = new FeedAgentExecutor();
  const feeProcessor = builtFeeProcessor(
    (
      executor as unknown as {
        buildPerpService: () => unknown;
      }
    ).buildPerpService.bind(executor)
  );

  expect(feeProcessor).toBeDefined();

  const result = await feeProcessor?.processTradingFee({
    userId: 'user-1',
    amount: 0,
    type: 'perp_open',
    relatedId: 'BTC',
    positionId: 'position-1',
  });
  expect(result?.feeCharged).toBe(0);
  expect(result?.referrerPaid).toBe(0);
});
