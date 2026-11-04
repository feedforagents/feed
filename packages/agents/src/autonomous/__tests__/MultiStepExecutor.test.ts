import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { StaticDataRegistry } from '@feed/engine';
import * as agentLLM from '../../llm/agent-llm';
import * as npcContextProvider from '../../plugins/feed/providers/npc-game-context';
import { normalizeDecisionAction } from '../action-normalization';
import { extractFirstJsonObject } from '../decision-json';
import { MultiStepExecutor } from '../MultiStepExecutor';
import { normalizeSocialDecisionParameters } from '../social-parameter-normalization';
import {
  Actions,
  type AgentTickContext,
  buildMultiStepDecisionPrompt,
  Features,
} from '../templates/multi-step-decision';
import { normalizeTradeDecisionParameters } from '../trade-parameter-normalization';

describe('decision response validation', () => {
  const runtime = { character: { settings: {} } } as unknown as IAgentRuntime;
  const missingThought = JSON.stringify({
    action: 'TRADE',
    parameters: {
      marketId: 'market-1',
      marketType: 'prediction',
      side: 'buy_yes',
      amount: 10,
    },
    isFinish: false,
  });
  const validDecision = JSON.stringify({
    thought: 'I have no further action.',
    action: 'FINISH',
    parameters: {},
    isFinish: true,
  });

  afterEach(() => mock.restore());

  test('sends missing-field feedback on the next transport request', async () => {
    const call = spyOn(agentLLM, 'callAgentLLM')
      .mockResolvedValueOnce(missingThought)
      .mockResolvedValueOnce(validDecision);
    const result = await new MultiStepExecutor()['getDecision'](
      'Choose an action',
      runtime,
      1
    );
    expect(result?.decision.thought).toBe('I have no further action.');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0].prompt).toContain(
      'Decision requires action, thought, and object parameters; isFinish, if provided, must be boolean'
    );
    expect(call.mock.calls[1]?.[0].prompt).not.toContain('malformed JSON');
  });

  test('exhausts all three attempts when thought is repeatedly missing', async () => {
    const call = spyOn(agentLLM, 'callAgentLLM').mockResolvedValue(
      missingThought
    );
    const result = await new MultiStepExecutor()['getDecision'](
      'Choose an action',
      runtime,
      1
    );
    expect(result).toBeNull();
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2]?.[0].prompt).toContain(
      'Decision requires action, thought, and object parameters; isFinish, if provided, must be boolean'
    );
  });

  for (const { action, isFinish, legacy } of [
    { action: 'TRADE', isFinish: false, legacy: undefined },
    { action: 'FINISH', isFinish: true, legacy: undefined },
    { action: 'WAIT', isFinish: true, legacy: undefined },
    { action: 'TRADE', isFinish: false, legacy: true },
    { action: 'FINISH', isFinish: true, legacy: false },
    { action: 'WAIT', isFinish: true, legacy: false },
  ]) {
    test(`derives terminal state for ${action} with legacy flag ${legacy}`, async () => {
      const response = JSON.stringify({
        thought: 'A brief decision.',
        action,
        parameters: {},
        ...(legacy === undefined ? {} : { isFinish: legacy }),
      });
      const call = spyOn(agentLLM, 'callAgentLLM').mockResolvedValue(response);
      const result = await new MultiStepExecutor()['getDecision'](
        'Choose an action',
        runtime,
        1
      );
      expect(result?.decision).toEqual({
        thought: 'A brief decision.',
        action,
        parameters: {},
        isFinish,
      });
      expect(call).toHaveBeenCalledTimes(1);
    });
  }
  test('rejects nonboolean legacy finish flags rather than inventing a decision', async () => {
    const call = spyOn(agentLLM, 'callAgentLLM').mockResolvedValue(
      JSON.stringify({
        thought: 'Check the market.',
        action: 'TRADE',
        parameters: {},
        isFinish: 'false',
      })
    );
    const result = await new MultiStepExecutor()['getDecision'](
      'Choose an action',
      runtime,
      1
    );
    expect(result).toBeNull();
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[1]?.[0].prompt).toContain(
      'isFinish, if provided, must be boolean'
    );
  });

  test('keeps malformed JSON feedback for syntax errors', async () => {
    const call = spyOn(agentLLM, 'callAgentLLM')
      .mockResolvedValueOnce('{"action":}')
      .mockResolvedValueOnce(validDecision);
    const result = await new MultiStepExecutor()['getDecision'](
      'Choose an action',
      runtime,
      1
    );
    expect(result?.decision.action).toBe('FINISH');
    expect(call.mock.calls[1]?.[0].prompt).toContain('malformed JSON');
  });

  test('specifies required decision fields without prescribing FINISH and respects the NPC step limit', () => {
    const { prompt } = buildMultiStepDecisionPrompt({
      agentName: 'Test NPC',
      iterationCount: 1,
      maxIterations: 4,
      traceActionResults: [],
      isNpc: true,
      shareTradeRoll: 0.9,
      context: {
        balance: 100,
        pnl: 0,
        openPositions: 0,
        pendingCommentReplies: [],
        pendingChatMessages: [
          {
            id: 'message-1',
            chatId: '376080731199242240',
            chatName: 'Test DM',
            isGroupChat: false,
            author: 'observer',
            content: 'What evidence would you watch?',
            recentMessages: [],
            formattedContext: 'observer: What evidence would you watch?',
            timestamp: new Date(),
          },
        ],
        enabledFeatures: [Features.TRADING, Features.DMS],
        predictionMarkets: [],
        perpMarkets: [],
        recentPosts: [],
        agentPositions: { predictions: [], perps: [] },
      },
    });
    const format = prompt
      .split('# Output Format (JSON only, no markdown)\n')[1]
      ?.split('## Parameter Schemas')[0];
    expect(format).toContain('three required fields');
    expect(format).toContain('"thought": a nonempty string');
    expect(format).toContain('"action": one action string');
    expect(format).toContain('"parameters": an object');
    expect(format).not.toContain('"isFinish"');
    expect(format).not.toContain('"action": "FINISH"');
    const displayedChatId = prompt.match(/chatId: ("\d+")/)?.[1];
    expect(displayedChatId).toBeDefined();
    expect(JSON.parse(displayedChatId!)).toBe('376080731199242240');
    expect(prompt).toContain('Never use JSON numbers for IDs');
    expect(prompt).toContain('up to 4 iterations');
    expect(prompt).not.toContain('5-10 actions');
    expect(prompt).not.toContain('at least 5 different things');
  });

  test('only encourages posting after trades when posting is enabled', () => {
    const traceActionResults = Array.from({ length: 3 }, () => ({
      actionType: Actions.TRADE,
      success: true,
      timestamp: Date.now(),
    }));
    const makePrompt = (enabledFeatures: string[]) =>
      buildMultiStepDecisionPrompt({
        agentName: 'Test NPC',
        iterationCount: 4,
        maxIterations: 4,
        traceActionResults,
        isNpc: true,
        shareTradeRoll: 0.9,
        context: {
          balance: 100,
          pnl: 0,
          openPositions: 0,
          pendingCommentReplies: [],
          pendingChatMessages: [],
          enabledFeatures,
          predictionMarkets: [],
          perpMarkets: [],
          recentPosts: [],
          agentPositions: { predictions: [], perps: [] },
        },
      }).prompt;

    expect(makePrompt([Features.TRADING])).not.toContain('**TIME TO POST**');
    expect(makePrompt([Features.TRADING, Features.POSTING])).toContain(
      '**TIME TO POST**'
    );
  });
});

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

  test('rejects a tick after three decisions omit the required thought', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockRestore();
    const call = spyOn(agentLLM, 'callAgentLLM').mockResolvedValue(
      JSON.stringify({
        action: 'LIKE',
        parameters: { postId: 'post-1' },
        isFinish: false,
      })
    );

    await expect(executor.execute(actor.id, runtime, true)).rejects.toThrow(
      `Failed to parse decision for agent ${actor.id}`
    );
    expect(call).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
  });

  test('retries a disabled action before executing the corrected allowed action', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockResolvedValueOnce({
      decision: {
        thought: 'Post an update',
        action: Actions.POST,
        parameters: { content: 'An update' },
        isFinish: false,
      },
      rawResponse: '{}',
    });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'feature "posting" is disabled'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('repeated disabled decisions exhaust the existing two attempts without execution', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockResolvedValue({
      decision: {
        thought: 'Post an update',
        action: Actions.POST,
        parameters: { content: 'An update' },
        isFinish: false,
      },
      rawResponse: '{}',
    });

    await expect(executor.execute(actor.id, runtime, true)).rejects.toThrow(
      'feature "posting" is disabled'
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  test('direct execution still blocks a disabled feature', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, execute } = prepare(executor);
    execute.mockRestore();

    const result = await executor['executeAction'](
      actor.id,
      Actions.POST,
      { content: 'An update' },
      [Features.ENGAGING],
      runtime,
      true
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Feature "posting" is disabled');
  });

  test('invalid configured budgets still fail', () => {
    for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MultiStepExecutor(budget)).toThrow(
        'Iteration budgets must be positive integers'
      );
    }
  });
});

describe('retired payment actions', () => {
  for (const action of ['SEND_MONEY', 'REQUEST_PAYMENT']) {
    test(`${action} cannot be restored by a legacy transfers feature flag`, async () => {
      const result = await new MultiStepExecutor()['executeAction'](
        'retired-sender',
        action,
        {
          recipientId: 'retired-recipient',
          amount: 25,
          reason: 'Retired action regression',
        },
        ['transfers'],
        {} as IAgentRuntime,
        false
      );
      expect(Object.values(Actions)).not.toContain(action);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`Action "${action}" is not recognized`);
    });
  }
});
