import { describe, expect, test } from 'bun:test';
import { MultiStepExecutor } from '../MultiStepExecutor';
import {
  Actions,
  type AgentTickContext,
  Features,
} from '../templates/multi-step-decision';
import { normalizeTradeDecisionParameters } from '../trade-parameter-normalization';

function createContext(): AgentTickContext {
  return {
    balance: 1000,
    pnl: 0,
    openPositions: 2,
    pendingCommentReplies: [],
    pendingChatMessages: [],
    enabledFeatures: [Features.TRADING],
    predictionMarkets: [
      {
        id: '123456',
        question: 'Will AIlon Musk ship FSD 14.0 by May 1, 2026?',
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 1000,
        maxSafeBet: 100,
        endDate: '2026-05-01T00:00:00.000Z',
      },
    ],
    perpMarkets: [
      {
        ticker: 'NVDAI',
        name: 'NVIDAI',
        currentPrice: 1650,
        initialPrice: 1250,
        changePercent: 32,
        maxOrderSize: 10_000,
      },
    ],
    recentPosts: [],
    agentPositions: {
      predictions: [
        {
          marketId: '987654',
          question: 'Will the Fed cut rates before year end?',
          side: 'NO',
          shares: 42,
          avgPrice: 0.61,
          currentPrice: 0.58,
          pnlPercent: -4.9,
          timeHeld: '2h',
          timeHeldMs: 7_200_000,
        },
      ],
      perps: [
        {
          ticker: 'TSLAI',
          side: 'long',
          size: 500,
          maxOrderSize: 10_000,
          entryPrice: 200,
          currentPrice: 220,
          pnl: 50,
          pnlPercent: 10,
          timeHeld: '3h',
          timeHeldMs: 10_800_000,
        },
      ],
    },
  };
}

function validateTrade(
  parameters: Record<string, unknown>,
  context: AgentTickContext
): string | undefined {
  const executor = new MultiStepExecutor(1);
  return executor['getDecisionValidationError'](
    Actions.TRADE,
    parameters,
    context
  );
}

describe('normalizeTradeDecisionParameters for held positions outside top-N quotes', () => {
  test('resolves generic sell side and marketType for a held-only prediction market id', () => {
    const context = createContext();
    const normalized = normalizeTradeDecisionParameters(
      { marketId: '987654', side: 'sell', amount: 0 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'prediction',
      marketId: '987654',
      side: 'sell_no',
      amount: 0,
    });
    expect(validateTrade(normalized, context)).toBeUndefined();
  });

  test('resolves non-numeric direct ids for held-only prediction positions', () => {
    const context = createContext();
    context.agentPositions.predictions.push({
      marketId: 'market-held-only',
      question: 'Will the bridge reopen this quarter?',
      side: 'YES',
      shares: 15,
      avgPrice: 0.45,
      currentPrice: 0.55,
      pnlPercent: 22.2,
      timeHeld: '4h',
      timeHeldMs: 14_400_000,
    });

    const normalized = normalizeTradeDecisionParameters(
      { marketId: 'market-held-only', side: 'sell', amount: 0 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'prediction',
      marketId: 'market-held-only',
      side: 'sell_yes',
      amount: 0,
    });
    expect(validateTrade(normalized, context)).toBeUndefined();
  });

  test('does not close a held perp when selling a prediction whose question starts with the ticker', () => {
    const context = createContext();
    context.agentPositions.predictions[0] = {
      ...context.agentPositions.predictions[0]!,
      question: 'TSLAI beats Q3 deliveries?',
    };

    const normalized = normalizeTradeDecisionParameters(
      { marketId: 'TSLAI beats Q3 deliveries?', side: 'sell', amount: 0 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'prediction',
      marketId: '987654',
      side: 'sell_no',
      amount: 0,
    });
    expect(validateTrade(normalized, context)).toBeUndefined();
  });

  test('strips decorated labels and numeric JSON ids for held-only prediction positions', () => {
    const context = createContext();

    const decorated = normalizeTradeDecisionParameters(
      {
        marketType: 'prediction',
        marketId: '987654: Will the Fed cut rates before year end?',
        side: 'sell_no',
        amount: 0,
      },
      context
    );
    expect(decorated).toEqual({
      marketType: 'prediction',
      marketId: '987654',
      side: 'sell_no',
      amount: 0,
    });
    expect(validateTrade(decorated, context)).toBeUndefined();

    const numericId = normalizeTradeDecisionParameters(
      {
        marketId: 987654,
        side: 'take_profit',
        amount: 0,
      },
      context
    );
    expect(numericId).toEqual({
      marketType: 'prediction',
      marketId: '987654',
      side: 'sell_no',
      amount: 0,
    });
    expect(validateTrade(numericId, context)).toBeUndefined();
  });

  test('still refuses ambiguous generic sell when both sides are held on a held-only prediction', () => {
    const context = createContext();
    context.agentPositions.predictions.push({
      ...context.agentPositions.predictions[0]!,
      side: 'YES',
    });

    const normalized = normalizeTradeDecisionParameters(
      { marketId: '987654', side: 'sell', amount: 0 },
      context
    );

    expect(normalized.marketType).toBe('prediction');
    expect(normalized.marketId).toBe('987654');
    expect(normalized.side).toBeUndefined();
    expect(validateTrade(normalized, context)).toBeDefined();
  });

  test('still rejects buying a held-only prediction market without a live quote', () => {
    const context = createContext();
    const normalized = normalizeTradeDecisionParameters(
      { marketId: '987654', side: 'buy_yes', amount: 25 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'prediction',
      marketId: '987654',
      side: 'buy_yes',
      amount: 25,
    });
    expect(validateTrade(normalized, context)).toContain(
      'Buy only an ID under Available Prediction Markets'
    );
  });

  test('resolves generic close side and marketType for a held-only perp ticker', () => {
    const context = createContext();
    const normalized = normalizeTradeDecisionParameters(
      { marketId: 'TSLAI', side: 'close', amount: 0 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'perp',
      marketId: 'TSLAI',
      side: 'close_position',
      amount: 0,
    });
    expect(validateTrade(normalized, context)).toBeUndefined();
  });

  test('canonicalizes lowercase and decorated held-only perp tickers', () => {
    const context = createContext();

    const lower = normalizeTradeDecisionParameters(
      { marketId: 'tslai', side: 'close_position', amount: 0 },
      context
    );
    expect(lower).toEqual({
      marketType: 'perp',
      marketId: 'TSLAI',
      side: 'close_position',
      amount: 0,
    });
    expect(validateTrade(lower, context)).toBeUndefined();

    const decorated = normalizeTradeDecisionParameters(
      {
        marketType: 'perp',
        marketId: 'TSLAI: $500 size',
        side: 'stop_loss',
        amount: 0,
      },
      context
    );
    expect(decorated).toEqual({
      marketType: 'perp',
      marketId: 'TSLAI',
      side: 'close_position',
      amount: 0,
    });
    expect(validateTrade(decorated, context)).toBeUndefined();
  });

  test('does not misroute a generic buy on a held-only perp into a prediction trade', () => {
    const context = createContext();
    const normalized = normalizeTradeDecisionParameters(
      { marketId: 'TSLAI', side: 'buy', amount: 200 },
      context
    );

    expect(normalized).toEqual({
      marketType: 'perp',
      marketId: 'TSLAI',
      side: 'open_long',
      amount: 200,
    });
    expect(validateTrade(normalized, context)).toBeUndefined();
  });

  test('does not redirect unknown or substring-matching identifiers to held positions', () => {
    const context = createContext();

    const unknownPred = normalizeTradeDecisionParameters(
      { marketType: 'prediction', marketId: '987655', side: 'sell', amount: 0 },
      context
    );
    expect(unknownPred.marketId).toBe('987655');
    expect(unknownPred.side).toBeUndefined();
    expect(validateTrade(unknownPred, context)).toBeDefined();

    const substringPerp = normalizeTradeDecisionParameters(
      {
        marketType: 'perp',
        marketId: 'NOT-TSLAI-FUND',
        side: 'close_position',
        amount: 0,
      },
      context
    );
    expect(substringPerp.marketId).toBe('NOT-TSLAI-FUND');
    expect(validateTrade(substringPerp, context)).toContain(
      'ticker is not in the current context'
    );
  });
});
