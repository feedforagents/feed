import { describe, expect, test } from 'bun:test';
import { getSafeContextLimit } from '../../engine/src/llm/token-counter';
import { parseXML } from '../../engine/src/llm/xml-parser';
import type { NPCMarketContext } from '../../engine/src/types/market-context';
import type { TradingDecision } from '../../engine/src/types/market-decisions';
import { formatSingleNPCDashboard } from '../../engine/src/utils/trading-dashboard-format';
import { validateTradingDecisions } from '../../engine/src/utils/validate-trading-decisions';

const context: NPCMarketContext = {
  npcId: 'npc-a',
  npcName: 'NPC A',
  personality: 'careful',
  tier: 'A',
  availableBalance: 100,
  recentPosts: [],
  groupChatMessages: [],
  recentEvents: [],
  perpMarkets: [],
  predictionMarkets: [],
  currentPositions: [],
};
const contexts = new Map([[context.npcId, context]]);
const hold: TradingDecision = {
  npcId: 'npc-a',
  npcName: 'NPC A',
  action: 'hold',
  marketType: null,
  amount: 0,
  confidence: 0.8,
  reasoning: 'No opportunity within risk limits.',
};
describe('Strict trading contracts', () => {
  test('preserves legitimate holds and optional null target fields', () => {
    const raw = { ...hold, ticker: null, marketId: null, positionId: null };
    const result = validateTradingDecisions(
      [raw as unknown as TradingDecision],
      contexts
    );
    expect(result[0]?.action).toBe('hold');
    expect(result[0]?.ticker).toBeUndefined();
  });
  test('does not change a misspelled actor into another actor', () => {
    expect(() =>
      validateTradingDecisions([{ ...hold, npcId: 'npc-b' }], contexts)
    ).toThrow('Unknown NPC');
  });
  test('rejects repeated decisions for an actor', () => {
    expect(() => validateTradingDecisions([hold, hold], contexts)).toThrow(
      'Duplicate'
    );
  });
  test('rejects missing, null and non-finite required values', () => {
    for (const amount of [
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        validateTradingDecisions(
          [{ ...hold, amount } as TradingDecision],
          contexts
        )
      ).toThrow();
    }
    expect(() =>
      validateTradingDecisions([{ ...hold, reasoning: '' }], contexts)
    ).toThrow();
    expect(() =>
      validateTradingDecisions([{ ...hold, confidence: 2 }], contexts)
    ).toThrow();
  });
  test('a hold cannot contain a hidden trade amount', () => {
    expect(() =>
      validateTradingDecisions([{ ...hold, amount: 10 }], contexts)
    ).toThrow('Hold/wait');
  });
  test('reserves output tokens inside the model window', () => {
    const limit = getSafeContextLimit('qwen3-32b', 8000);
    expect(limit + 8000).toBeLessThan(32768);
    expect(() => getSafeContextLimit('qwen3-32b', 32768)).toThrow();
    expect(() => getSafeContextLimit('qwen3-32b', Number.NaN)).toThrow();
  });
  test('uses the configured compatible endpoint context size', () => {
    const keys = ['SURPLUS_API_KEY', 'SURPLUS_MODEL', 'SURPLUS_CONTEXT_TOKENS'];
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.SURPLUS_API_KEY = 'local-test-key';
      process.env.SURPLUS_MODEL = 'local-instruct';
      process.env.SURPLUS_CONTEXT_TOKENS = '32768';
      expect(getSafeContextLimit('local-instruct', 1000)).toBe(31112);
      expect(getSafeContextLimit('other-model', 1000)).toBe(7028);
      delete process.env.SURPLUS_CONTEXT_TOKENS;
      expect(getSafeContextLimit('local-instruct', 1000)).toBe(7028);
      for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
        process.env.SURPLUS_CONTEXT_TOKENS = invalid;
        expect(() => getSafeContextLimit('local-instruct', 1000)).toThrow(
          'SURPLUS_CONTEXT_TOKENS must be a positive integer'
        );
      }
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
  test('keeps opaque XML identifiers as strings', () => {
    const parsed = parseXML(
      '<response><marketId>367525326588215296</marketId><npcId>1234</npcId><amount>25</amount></response>'
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      marketId: '367525326588215296',
      npcId: '1234',
      amount: 25,
    });
  });
});

test('truncated or mismatched XML is rejected instead of inventing closing tags', () => {
  expect(
    parseXML('<decisions><decision><npcId>123</npcId></decision>').success
  ).toBe(false);
  expect(parseXML('<decisions><decision></decisions></decision>').success).toBe(
    false
  );
});

test('NPC dashboard preserves fetched personalized evidence and complete private messages', () => {
  const detail = 'Long premise '.repeat(20) + 'BUT THIS IS NOT CONFIRMED';
  const dashboard = formatSingleNPCDashboard({
    ...context,
    recentPosts: [
      {
        author: 'source',
        authorName: 'Source',
        content: detail,
        timestamp: '2026-10-11T00:00:00Z',
      },
    ],
    recentEvents: [
      {
        type: 'news',
        description: 'Required event qualifier',
        timestamp: '2026-10-11T00:00:00Z',
      },
    ],
    groupChatMessages: Array.from({ length: 8 }, (_, i) => ({
      chatId: 'chat',
      chatName: 'Private',
      from: 'source',
      fromName: 'Source',
      message: `message-${i}: ${detail}`,
      timestamp: '2026-10-11T00:00:00Z',
    })),
  });
  expect(dashboard).toContain(detail);
  expect(dashboard).toContain('Required event qualifier');
  expect(dashboard).toContain('message-7:');
});
