import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { StaticDataRegistry } from '@feed/engine';
import * as npcContextProvider from '../../plugins/feed/providers/npc-game-context';
import { normalizeDecisionAction } from '../action-normalization';
import { extractFirstJsonObject } from '../decision-json';
import { MultiStepExecutor } from '../MultiStepExecutor';
import { normalizeSocialDecisionParameters } from '../social-parameter-normalization';
import {
  Actions,
  type AgentTickContext,
  Features,
} from '../templates/multi-step-decision';
import { normalizeTradeDecisionParameters } from '../trade-parameter-normalization';

describe('normalizeDecisionAction', () => {
  test('preserves valid actions', () => {
    expect(normalizeDecisionAction('TRADE')).toBe('TRADE');
    expect(normalizeDecisionAction('reply_chat')).toBe('REPLY_CHAT');
  });

  test('does not select an action from ambiguous labels', () => {
    expect(normalizeDecisionAction('TRADE | REPLY_CHAT')).not.toBe('TRADE');
    expect(
      normalizeDecisionAction('TRADE | REPLY_COMMENT | GROUP_MESSAGE | FINISH')
    ).not.toBe('TRADE');
  });

  test('normalizes whitespace and hyphenated labels', () => {
    expect(normalizeDecisionAction('group message')).toBe('GROUP_MESSAGE');
    expect(normalizeDecisionAction('reply-chat')).toBe('REPLY_CHAT');
  });

  test('does not invent actions from incomplete labels', () => {
    expect(normalizeDecisionAction('TR')).toBe('TR');
    expect(normalizeDecisionAction('trad')).toBe('TRAD');
    expect(normalizeDecisionAction('POS')).toBe('POS');
  });
});

describe('normalizeTradeDecisionParameters', () => {
  const context = {
    predictionMarkets: [
      {
        id: '123456',
        question: 'Will AIlon Musk ship FSD 14.0 by May 1, 2026?',
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 1000,
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
      },
    ],
    agentPositions: {
      predictions: [
        {
          marketId: '123456',
          question: 'Will AIlon Musk ship FSD 14.0 by May 1, 2026?',
          side: 'NO',
          shares: 42,
          avgPrice: 0.61,
          currentPrice: 0.58,
          pnlPercent: -4.9,
          timeHeld: '2h',
          timeHeldMs: 7200000,
        },
      ],
      perps: [],
    },
  } as const;

  test('maps decorated perp labels back to tickers', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'perp',
          marketId: 'NVDAI: NVIDAI @ $1650.00',
          side: 'open_long',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'perp',
      marketId: 'NVDAI',
      side: 'open_long',
    });
  });

  test('does not convert a prediction trade into a perp trade', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: 'NVDAI: NVIDAI @ $1650.00',
          side: 'buy_yes',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: 'NVDAI: NVIDAI @ $1650.00',
      side: 'buy_yes',
    });
  });

  test('resolves numeric prediction market ids from question-like text', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: 'Will AIlon Musk ship FSD 14.0 by May 1, 2026?',
          side: 'buy_yes',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: '123456',
      side: 'buy_yes',
    });
  });

  test('does not redirect hallucinated market ids to a nearby market', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: '123458',
          side: 'buy_yes',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: '123458',
      side: 'buy_yes',
    });
  });

  test('removes noop trade sides instead of leaving executable garbage', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: '123456',
          side: 'none',
        },
        context as never
      )
    ).toEqual({
      marketType: 'prediction',
      marketId: '123456',
    });
  });

  test('never switches an explicit sell side to another holding', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: '123456',
          side: 'sell_yes',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: '123456',
      side: 'sell_yes',
    });
  });

  test('normalizes market type aliases instead of preserving bogus values', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'perception',
          marketId: '123456',
          side: 'sell_no',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: '123456',
      side: 'sell_no',
    });
  });

  test('does not guess a sell side when both outcomes are held', () => {
    const bothSides = {
      ...context,
      agentPositions: {
        ...context.agentPositions,
        predictions: [
          ...context.agentPositions.predictions,
          { ...context.agentPositions.predictions[0], side: 'YES' },
        ],
      },
    };
    const result = normalizeTradeDecisionParameters(
      { marketType: 'prediction', marketId: '123456', side: 'sell' },
      bothSides as never
    );
    expect(result.side).toBeUndefined();
    expect(
      normalizeTradeDecisionParameters(
        { marketType: 'prediction', marketId: '123456', side: 'sell' },
        context as never
      ).side
    ).toBe('sell_no');
  });

  test('does not resolve a perp ticker from a name substring', () => {
    expect(
      normalizeTradeDecisionParameters(
        { marketType: 'perp', marketId: 'NOT-NVIDAI-FUND', side: 'open_long' },
        context as never
      )
    ).toMatchObject({ marketId: 'NOT-NVIDAI-FUND' });
  });

  test('rescues numeric market ids emitted as JSON numbers', () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: 'prediction',
          marketId: 123456,
          side: 'buy_yes',
        },
        context as never
      )
    ).toMatchObject({
      marketType: 'prediction',
      marketId: '123456',
      side: 'buy_yes',
    });
  });
});

describe('normalizeSocialDecisionParameters', () => {
  const context = {
    recentPosts: [
      {
        id: 'post-1',
        authorId: 'user-1',
        authorName: 'alpha',
        content: 'first post',
        commentCount: 4,
        likeCount: 10,
        repostCount: 1,
        timeAgo: '1m',
      },
      {
        id: 'post-2',
        authorId: 'user-2',
        authorName: 'beta',
        content: 'second post',
        commentCount: 3,
        likeCount: 5,
        repostCount: 0,
        timeAgo: '2m',
        agentComment: 'already replied',
      },
    ],
    pendingCommentReplies: [
      {
        id: 'comment-1',
        postId: 'post-1',
      },
    ],
    pendingChatMessages: [
      {
        chatId: 'chat-1',
      },
    ],
    groupChats: [
      {
        id: 'group-1',
      },
    ],
  } as const;

  test('does not invent comment targets for placeholder ids', () => {
    expect(
      normalizeSocialDecisionParameters(
        'COMMENT',
        {
          postId: 'none',
          parentCommentId: 'none',
          content: 'hello',
        },
        context as never,
        'agent-1'
      )
    ).toEqual({
      content: 'hello',
    });
  });

  test('maps ordinal reply references to pending comment ids and post ids', () => {
    expect(
      normalizeSocialDecisionParameters(
        'REPLY_COMMENT',
        {
          commentId: '1',
          postId: 'none',
          content: 'reply',
        },
        context as never,
        'agent-1'
      )
    ).toMatchObject({
      commentId: 'comment-1',
      postId: 'post-1',
      content: 'reply',
    });
  });

  test('does not invent DM recipients or reply chats', () => {
    expect(
      normalizeSocialDecisionParameters(
        'DM',
        {
          recipientId: 'none',
          content: 'ping',
        },
        context as never,
        'agent-1'
      )
    ).toEqual({
      content: 'ping',
    });

    expect(
      normalizeSocialDecisionParameters(
        'REPLY_CHAT',
        {
          chatId: 'none',
          content: 'pong',
        },
        context as never,
        'agent-1'
      )
    ).toEqual({
      content: 'pong',
    });
  });

  test('rescues numeric social ids emitted as JSON numbers', () => {
    expect(
      normalizeSocialDecisionParameters(
        'COMMENT',
        {
          postId: 1,
          content: 'hello',
        },
        context as never,
        'agent-1'
      )
    ).toMatchObject({
      postId: 'post-1',
      content: 'hello',
    });
  });
  test('rejects a parent comment that belongs to a different post', () => {
    expect(
      normalizeSocialDecisionParameters(
        'COMMENT',
        { postId: 'post-2', parentCommentId: 'comment-1', content: 'hi' },
        context as never,
        'agent-1'
      )
    ).toEqual({ content: 'hi' });
  });

  test('keeps a well-formed explicit id that is outside the rendered context', () => {
    expect(
      normalizeSocialDecisionParameters(
        'FOLLOW',
        { userId: '1234567890123456789' },
        context as never,
        'agent-1'
      )
    ).toEqual({ userId: '1234567890123456789' });
  });

  test('never repairs free text or out-of-range ordinals into a target', () => {
    expect(
      normalizeSocialDecisionParameters(
        'DM',
        { recipientId: 'the user who posted 2', content: 'x' },
        context as never,
        'agent-1'
      )
    ).toEqual({ content: 'x' });
    expect(
      normalizeSocialDecisionParameters(
        'LIKE',
        { postId: '#7' },
        context as never,
        'agent-1'
      )
    ).toEqual({});
  });
});

describe('extractFirstJsonObject', () => {
  test('extracts JSON from responses wrapped in think tags and code fences', () => {
    expect(
      extractFirstJsonObject(
        '<think>internal</think>\n```json\n{"action":"TRADE","isFinish":false,"parameters":{}}\n```'
      )
    ).toBe('{"action":"TRADE","isFinish":false,"parameters":{}}');
  });

  test('returns null when no JSON object exists', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});

describe('getDecisionValidationError', () => {
  const executor = new MultiStepExecutor();
  const context = {
    predictionMarkets: [],
    perpMarkets: [],
    agentPositions: { predictions: [], perps: [] },
    recentPosts: [
      {
        id: 'post-1',
        authorId: 'user-1',
        authorName: 'alpha',
        content: 'first post',
        commentCount: 4,
        likeCount: 10,
        repostCount: 1,
        timeAgo: '1m',
        agentComment: 'existing comment',
        agentLiked: true,
        agentReposted: true,
      },
    ],
    pendingCommentReplies: [],
    pendingChatMessages: [],
    groupChats: [],
    openPositions: 0,
  } as const;

  test('rejects duplicate social actions before direct execution', () => {
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        'COMMENT',
        { postId: 'post-1', content: 'new comment' },
        context
      )
    ).toContain('already made a top-level comment');

    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        'LIKE',
        { postId: 'post-1' },
        context
      )
    ).toContain('already liked');

    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        'REPOST',
        { postId: 'post-1' },
        context
      )
    ).toContain('already reposted');
  });
});

describe('tick success reflects execution outcomes', () => {
  test('valid inactivity succeeds but a failed action never does', () => {
    const executor = new MultiStepExecutor();
    expect(executor['aggregateResults']([], Date.now()).success).toBe(true);
    expect(
      executor['aggregateResults'](
        [
          {
            actionType: 'TRADE',
            success: false,
            parameters: {},
            summary: 'Rejected',
            timestamp: Date.now(),
          },
        ],
        Date.now()
      ).success
    ).toBe(false);
  });
});

describe('NPC iteration ceiling (PRD D-25)', () => {
  const actor = StaticDataRegistry.getAllActors()[0]!;
  afterEach(() => mock.restore());

  function prepare(executor: MultiStepExecutor) {
    const runtime = {
      agentId: actor.id,
      character: {
        name: actor.name,
        feed: {
          autonomy: {
            trading: false,
            posting: false,
            commenting: false,
            dms: false,
            groups: false,
          },
        },
      },
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;
    const context: AgentTickContext = {
      balance: 100,
      pnl: 0,
      openPositions: 0,
      pendingCommentReplies: [],
      pendingChatMessages: [],
      enabledFeatures: [Features.ENGAGING],
      predictionMarkets: [],
      perpMarkets: [],
      recentPosts: [
        {
          id: 'post-1',
          authorId: 'other',
          authorName: 'Other',
          content: 'An actionable post',
          commentCount: 0,
          likeCount: 0,
          repostCount: 0,
          timeAgo: '1m',
        },
      ],
      agentPositions: { predictions: [], perps: [] },
    };
    const internal = executor as unknown as {
      getDecision: MultiStepExecutor['getDecision'];
      executeAction: MultiStepExecutor['executeAction'];
      getLatestContextRefreshSummary: MultiStepExecutor['getLatestContextRefreshSummary'];
      recordTrajectoryStep: MultiStepExecutor['recordTrajectoryStep'];
    };
    spyOn(npcContextProvider, 'getNpcGameContext').mockResolvedValue('');
    spyOn(executor, 'gatherContext').mockResolvedValue(context);
    spyOn(internal, 'getLatestContextRefreshSummary').mockResolvedValue(
      undefined
    );
    spyOn(internal, 'recordTrajectoryStep').mockResolvedValue(undefined);
    const decision = spyOn(internal, 'getDecision').mockResolvedValue({
      decision: {
        thought: 'Continue engaging',
        action: Actions.LIKE,
        parameters: { postId: 'post-1' },
        isFinish: false,
      },
      rawResponse: '{}',
    });
    const execute = spyOn(internal, 'executeAction').mockResolvedValue({
      actionType: Actions.LIKE,
      success: true,
      parameters: { postId: 'post-1' },
      summary: 'Liked',
      timestamp: Date.now(),
    });
    return { runtime, decision, execute };
  }

  for (const [label, executor, expected] of [
    ['default', () => new MultiStepExecutor(), 4],
    ['explicit larger budget', () => new MultiStepExecutor(12), 4],
    ['smaller budget', () => new MultiStepExecutor(2), 2],
  ] as const) {
    test(`NPC tick respects ${label}`, async () => {
      const instance = executor();
      const { runtime, decision, execute } = prepare(instance);
      const result = await instance.execute(actor.id, runtime, true);
      expect(result.success).toBe(true);
      expect(result.iterations).toBe(expected);
      expect(decision).toHaveBeenCalledTimes(expected);
      expect(execute).toHaveBeenCalledTimes(expected);
    });
  }

  test('NPC can finish before the ceiling', async () => {
    const executor = new MultiStepExecutor();
    const { runtime, decision, execute } = prepare(executor);
    decision.mockResolvedValueOnce({
      decision: {
        thought: 'Nothing to do',
        action: Actions.FINISH,
        parameters: {},
        isFinish: true,
      },
      rawResponse: '{}',
    });
    expect((await executor.execute(actor.id, runtime, true)).iterations).toBe(
      0
    );
    expect(decision).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test('invalid configured budgets still fail', () => {
    for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MultiStepExecutor(budget)).toThrow(
        'Iteration budgets must be positive integers'
      );
    }
  });
});
