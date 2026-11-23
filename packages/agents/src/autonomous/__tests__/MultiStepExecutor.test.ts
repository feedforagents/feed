import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { StaticDataRegistry } from '@feed/engine';
import { APICallError } from 'ai';
import * as agentLLM from '../../llm/agent-llm';
import * as npcContextProvider from '../../plugins/feed/providers/npc-game-context';
import { logger } from '../../shared/logger';
import { normalizeDecisionAction } from '../action-normalization';
import * as directExecutors from '../DirectExecutors';
import { extractFirstJsonObject } from '../decision-json';
import { MultiStepExecutor } from '../MultiStepExecutor';
import type { NpcMarketClue } from '../npc-market-clue';
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
        maxOrderSize: 10_000,
        minOrderSize: 10,
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
          commentId: 'none',
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
  test('preserves a supplied parent comment for validation', () => {
    expect(
      normalizeSocialDecisionParameters(
        'COMMENT',
        { postId: 'post-2', parentCommentId: 'comment-1', content: 'hi' },
        context as never,
        'agent-1'
      )
    ).toEqual({
      postId: 'post-2',
      parentCommentId: 'comment-1',
      content: 'hi',
    });
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

  test('rejects unlisted post and pending-chat IDs before dispatch', () => {
    const visibleContext = {
      ...context,
      pendingChatMessages: [{ chatId: 'chat-1' }],
    } as unknown as AgentTickContext;
    for (const action of [Actions.COMMENT, Actions.LIKE, Actions.REPOST]) {
      const parameters = normalizeSocialDecisionParameters(
        action,
        { postId: 'post-92', content: 'An opinion' },
        visibleContext,
        'agent-1'
      );
      expect(
        executor['getDecisionValidationError'](
          action,
          parameters,
          visibleContext
        )
      ).toContain('Recent Posts');
    }

    expect(
      executor['getDecisionValidationError'](
        Actions.REPLY_CHAT,
        { chatId: 'chat-92', content: 'A reply' },
        visibleContext
      )
    ).toContain('Pending Chat Messages');
    expect(
      executor['getDecisionValidationError'](
        Actions.REPLY_CHAT,
        { chatId: 'chat-1', content: 'A reply' },
        visibleContext
      )
    ).toBeUndefined();
  });

  test('rejects group-management targets that are not listed groups', () => {
    const visibleContext = {
      ...context,
      groupChats: [{ id: 'chat-1', groupId: 'group-1', name: 'Squad' }],
    } as unknown as AgentTickContext;
    const unlistedTargets: Array<[string, Record<string, unknown>]> = [
      [Actions.INVITE_TO_GROUP, { groupId: 'group-92', userId: 'user-5' }],
      [Actions.KICK_FROM_GROUP, { groupId: 'group-92', userId: 'user-5' }],
      [Actions.LEAVE_GROUP, { groupId: 'group-92' }],
      // The chat ID / group ID confusion the GROUP_MESSAGE correction exists for.
      [Actions.INVITE_TO_GROUP, { groupId: 'chat-1', userId: 'user-5' }],
      [Actions.LEAVE_GROUP, { groupId: 'chat-1' }],
    ];
    for (const [action, parameters] of unlistedTargets) {
      expect(
        executor['getDecisionValidationError'](
          action,
          parameters,
          visibleContext
        )
      ).toContain('Your Group Chats');
    }
    expect(
      executor['getDecisionValidationError'](
        Actions.LEAVE_GROUP,
        { groupId: 'group-1' },
        visibleContext
      )
    ).toBeUndefined();
    expect(
      executor['getDecisionValidationError'](
        Actions.INVITE_TO_GROUP,
        { groupId: 'group-1', userId: 'user-5' },
        { ...context, groupChats: [] } as unknown as AgentTickContext
      )
    ).toContain('Your Group Chats');
  });

  test('a COMMENT with explicit parent intent must use REPLY_COMMENT', () => {
    const visibleContext = {
      ...context,
      recentPosts: [{ ...context.recentPosts[0], agentComment: undefined }],
    } as unknown as AgentTickContext;
    for (const replyParameters of [
      { postId: 'post-1', parentCommentId: 'comment-42' },
      { postId: 'post-1', parentCommentId: 'comment by @author' },
      { postId: 'post-1', parentCommentId: Number.MAX_SAFE_INTEGER + 1 },
      { parentCommentId: { id: 'comment-42' } },
      { commentId: ['comment-42'] },
    ]) {
      const parameters = normalizeSocialDecisionParameters(
        Actions.COMMENT,
        { ...replyParameters, content: 'A reply' },
        visibleContext,
        'agent-1'
      );
      expect(
        executor['getDecisionValidationError'](
          Actions.COMMENT,
          parameters,
          visibleContext
        )
      ).toContain('replies must use REPLY_COMMENT');
    }
  });

  test('a pending reply exposes other authors’ posts for reposts and keeps own posts available for likes', () => {
    const visibleContext = {
      ...context,
      pendingCommentReplies: [
        { postId: 'post-2', post: { isYourPost: true } },
        { postId: 'post-3', post: { isYourPost: false } },
      ],
    } as unknown as AgentTickContext;
    expect(
      executor['getDecisionValidationError'](
        Actions.REPOST,
        { postId: 'post-2' },
        visibleContext
      )
    ).toContain('another author');
    expect(
      executor['getDecisionValidationError'](
        Actions.REPOST,
        { postId: 'post-3' },
        visibleContext
      )
    ).toBeUndefined();
    expect(
      executor['getDecisionValidationError'](
        Actions.LIKE,
        { postId: 'post-2' },
        visibleContext
      )
    ).toBeUndefined();
  });

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

  function prepare(
    executor: MultiStepExecutor,
    posting = false,
    trading = false,
    groups = false,
    dms = false
  ) {
    const runtime = {
      agentId: actor.id,
      character: {
        name: actor.name,
        feed: {
          autonomy: {
            trading,
            posting,
            commenting: false,
            dms,
            groups,
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
      enabledFeatures: posting
        ? [Features.ENGAGING, Features.POSTING]
        : [Features.ENGAGING],
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
    if (groups || dms) spyOn(Math, 'random').mockReturnValue(0.9);
    if (groups) context.enabledFeatures.push(Features.GROUP_CHATS);
    if (dms) context.enabledFeatures.push(Features.DMS);
    const internal = executor as unknown as {
      getDecision: MultiStepExecutor['getDecision'];
      executeAction: MultiStepExecutor['executeAction'];
      getLatestContextRefreshSummary: MultiStepExecutor['getLatestContextRefreshSummary'];
      recordTrajectoryStep: MultiStepExecutor['recordTrajectoryStep'];
    };
    const gameContext = spyOn(
      npcContextProvider,
      'getNpcGameContext'
    ).mockResolvedValue('');
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
    return { context, gameContext, runtime, decision, execute };
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

  function providerError(statusCode: number, retryAfter?: string) {
    return new APICallError({
      message: `Provider returned HTTP ${statusCode}`,
      url: 'https://provider.example/chat/completions',
      requestBodyValues: {},
      statusCode,
      responseHeaders: retryAfter ? { 'retry-after': retryAfter } : undefined,
    });
  }

  test.each([
    429, 502,
  ])('retries the same decision after HTTP %i without repeating a completed action', async (statusCode) => {
    const executor = new MultiStepExecutor(2);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockRestore();
    const { signal } = new AbortController();
    const call = spyOn(agentLLM, 'callAgentLLM')
      .mockResolvedValueOnce(
        JSON.stringify({
          thought: 'Like the available post.',
          action: Actions.LIKE,
          parameters: { postId: 'post-1' },
        })
      )
      .mockRejectedValueOnce(providerError(statusCode, '0'))
      .mockResolvedValueOnce(
        JSON.stringify({
          thought: 'Finish the tick.',
          action: Actions.FINISH,
          parameters: {},
        })
      );

    const result = await executor.execute(actor.id, runtime, true, signal);

    expect(result.success).toBe(true);
    expect(result.actionsExecuted.engagements).toBe(1);
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2]?.[0]).toEqual(call.mock.calls[1]?.[0]);
    expect(call.mock.calls[2]?.[0]).toMatchObject({ signal });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('shares the retry allowance between HTTP 429 and 502 across a decision correction', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockRestore();
    const first = providerError(429, '0');
    const later = providerError(502, '0');
    const call = spyOn(agentLLM, 'callAgentLLM')
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce(
        JSON.stringify({
          thought: 'Like an unavailable post.',
          action: Actions.LIKE,
          parameters: { postId: 'unavailable-999' },
        })
      )
      .mockRejectedValue(later);

    await expect(executor.execute(actor.id, runtime, true)).rejects.toBe(later);

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2]?.[0].prompt).toContain(
      'The target post is unavailable'
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test('cancels the backoff before a lease-aborted tick can retry', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor);
    decision.mockRestore();
    const controller = new AbortController();
    const call = spyOn(agentLLM, 'callAgentLLM').mockImplementationOnce(
      async () => {
        setTimeout(() => controller.abort(), 10);
        throw providerError(429, '1');
      }
    );

    await expect(
      executor.execute(actor.id, runtime, true, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(call).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  for (const [label, error, expectedCalls] of [
    ['a persistent rate limit', providerError(429, '0'), 2],
    ['a long Retry-After', providerError(429, '6'), 1],
    ['other provider errors', providerError(503, '0'), 1],
    [
      'a budget denial',
      new Error('Scheduled inference budget exhausted or suspended'),
      1,
    ],
  ] as const) {
    test(`keeps ${label} a failed decision`, async () => {
      const executor = new MultiStepExecutor(1);
      const { runtime, decision, execute } = prepare(executor);
      decision.mockRestore();
      const call = spyOn(agentLLM, 'callAgentLLM').mockRejectedValue(error);

      await expect(executor.execute(actor.id, runtime, true)).rejects.toBe(
        error
      );

      expect(call).toHaveBeenCalledTimes(expectedCalls);
      expect(execute).not.toHaveBeenCalled();
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

  test('corrects a GROUP_MESSAGE that uses a group ID in place of the chat ID', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      true
    );
    context.groupChats = [
      {
        id: '123456789012345678',
        groupId: '223456789012345678',
        name: 'Group',
      },
    ];
    const message = {
      thought: 'Talk with the group.',
      action: Actions.GROUP_MESSAGE,
      parameters: {
        chatId: '223456789012345678',
        content: 'Hello.',
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' })
      .mockResolvedValueOnce({
        decision: {
          ...message,
          parameters: {
            ...message.parameters,
            chatId: '123456789012345678',
          },
        },
        rawResponse: '{}',
      });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain('Your Group Chats');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.GROUP_MESSAGE);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      chatId: '123456789012345678',
    });
  });

  test('skips a repeated unknown GROUP_MESSAGE target and can take another step', async () => {
    const executor = new MultiStepExecutor(2);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      true
    );
    context.groupChats = [{ id: '123456789012345678', name: 'Group' }];
    const message = {
      thought: 'Talk with the group.',
      action: Actions.GROUP_MESSAGE,
      parameters: {
        chatId: '299999999999999999',
        content: 'Private group content.',
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' })
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.actionsExecuted.messages).toBe(0);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.GROUP_MESSAGE,
      success: false,
      result: { rejection: 'group-message-chat-unavailable' },
    });
    expect(result.trace[0]?.parameters).toBeUndefined();
    expect(decision).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('corrects an INVITE_TO_GROUP that uses a chat ID in place of the group ID', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      true
    );
    context.groupChats = [
      {
        id: '123456789012345678',
        groupId: '223456789012345678',
        name: 'Group',
      },
    ];
    const message = {
      thought: 'Grow the group.',
      action: Actions.INVITE_TO_GROUP,
      parameters: {
        groupId: '123456789012345678',
        userId: '299999999999999999',
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' })
      .mockResolvedValueOnce({
        decision: {
          ...message,
          parameters: {
            ...message.parameters,
            groupId: '223456789012345678',
          },
        },
        rawResponse: '{}',
      });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain('Your Group Chats');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.INVITE_TO_GROUP);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      groupId: '223456789012345678',
    });
  });

  test('skips a repeated unknown group-management target and can take another step', async () => {
    const executor = new MultiStepExecutor(2);
    const warn = spyOn(logger, 'warn');
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      true
    );
    context.groupChats = [
      {
        id: '123456789012345678',
        groupId: '223456789012345678',
        name: 'Group',
      },
    ];
    const message = {
      thought: 'Remove a participant.',
      action: Actions.KICK_FROM_GROUP,
      parameters: {
        groupId: '299999999999999999',
        userId: 'target-user',
        reason: 'Private group reason.',
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' })
      .mockResolvedValueOnce({ decision: message, rawResponse: '{}' });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.KICK_FROM_GROUP,
      success: false,
      result: { rejection: 'group-management-group-unavailable' },
    });
    expect(result.trace[0]?.parameters).toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('parameters');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'Private group reason.'
    );
    expect(decision).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('a repeated unavailable REPLY_CHAT is private and consumes one bounded step', async () => {
    const executor = new MultiStepExecutor();
    const { runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      true
    );
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const response = {
      decision: {
        thought: 'Reply in a chat.',
        action: Actions.REPLY_CHAT,
        parameters: { chatId: 'chat-92', content: 'Private reply content.' },
        isFinish: false,
      },
      rawResponse: '{}',
    };
    decision.mockResolvedValueOnce(response).mockResolvedValueOnce(response);

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(4);
    expect(result.actionsExecuted.messages).toBe(0);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.REPLY_CHAT,
      success: false,
      result: { rejection: 'social-target-unavailable' },
    });
    expect(result.trace[0]?.parameters).toBeUndefined();
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'Pending Chat Messages'
    );
    expect(decision).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      Actions.LIKE,
      Actions.LIKE,
      Actions.LIKE,
    ]);
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('parameters');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'Private reply content.'
    );
  });

  test('gives a perp order below the minimum after the balance cap the existing correction before dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 8;
    context.enabledFeatures.push(Features.TRADING);
    context.perpMarkets = [
      {
        ticker: 'NVDAI',
        name: 'NVIDAI',
        currentPrice: 100,
        initialPrice: 100,
        changePercent: 0,
        maxOrderSize: 10_000,
        minOrderSize: 10,
      },
    ];
    const trade = {
      thought: 'Open a long.',
      action: Actions.TRADE,
      parameters: {
        marketType: 'perp',
        marketId: 'NVDAI',
        side: 'open_long',
        amount: 50,
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: trade, rawResponse: '{}' })
      .mockResolvedValueOnce({
        decision: {
          thought: 'Like instead.',
          action: Actions.LIKE,
          parameters: { postId: 'post-1' },
          isFinish: false,
        },
        rawResponse: '{}',
      });

    expect((await executor.execute(actor.id, runtime, true)).success).toBe(
      true
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[0]?.[0]).toContain(
      'Minimum order size: 10 points'
    );
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'need at least 10 points after capping to your balance of 8'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('gives an entry trade with less than 1 point of balance the existing correction before dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 0.5;
    context.enabledFeatures.push(Features.TRADING);
    context.predictionMarkets = [
      {
        id: 'market-1',
        question: 'Will it happen?',
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 0,
        maxSafeBet: 500,
        endDate: '2026-12-31T00:00:00.000Z',
      },
    ];
    const trade = {
      thought: 'Buy yes.',
      action: Actions.TRADE,
      parameters: {
        marketType: 'prediction',
        marketId: 'market-1',
        side: 'buy_yes',
        amount: 25,
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: trade, rawResponse: '{}' })
      .mockResolvedValueOnce({
        decision: {
          thought: 'Like instead.',
          action: Actions.LIKE,
          parameters: { postId: 'post-1' },
          isFinish: false,
        },
        rawResponse: '{}',
      });

    expect((await executor.execute(actor.id, runtime, true)).success).toBe(
      true
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'Entry trades need at least 1 point after capping to your balance of 0.5'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  const likeInstead = {
    decision: {
      thought: 'Like instead.',
      action: Actions.LIKE,
      parameters: { postId: 'post-1' },
      isFinish: false,
    },
    rawResponse: '{}',
  };

  function perpTrade(side: string, amount: number) {
    return {
      decision: {
        thought: 'Trade the perp.',
        action: Actions.TRADE,
        parameters: { marketType: 'perp', marketId: 'NVDAI', side, amount },
        isFinish: false,
      },
      rawResponse: '{}',
    };
  }

  const nvdaiMarket = {
    ticker: 'NVDAI',
    name: 'NVIDAI',
    currentPrice: 100,
    initialPrice: 100,
    changePercent: 0,
    maxOrderSize: 10_000,
    minOrderSize: 10,
  };

  test('gives a capped perp order whose open fee exceeds the balance the existing correction before dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 20;
    context.enabledFeatures.push(Features.TRADING);
    context.perpMarkets = [nvdaiMarket];
    decision
      .mockResolvedValueOnce(perpTrade('open_long', 50))
      .mockResolvedValueOnce(likeInstead);

    expect((await executor.execute(actor.id, runtime, true)).success).toBe(
      true
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'cost 20.02 points including a 0.02 point fee, which exceeds your balance of 20'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('dispatches an affordable add using the held position leverage', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 10;
    context.enabledFeatures.push(Features.TRADING);
    context.openPositions = 1;
    context.perpMarkets = [nvdaiMarket];
    context.agentPositions.perps = [
      {
        ticker: 'NVDAI',
        side: 'long',
        size: 100,
        leverage: 5,
        minOrderSize: 10,
        pnl: 0,
        pnlPercent: 0,
        entryPrice: 100,
        currentPrice: 100,
        timeHeld: '20m',
        timeHeldMs: 1_200_000,
      },
    ];
    decision.mockResolvedValueOnce(perpTrade('open_long', 50));
    expect((await executor.execute(actor.id, runtime, true)).success).toBe(
      true
    );
    expect(decision).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      marketId: 'NVDAI',
      side: 'open_long',
      amount: 50,
    });
  });

  test('gives a perp flip whose new leg is below the minimum the existing correction before dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 100;
    context.enabledFeatures.push(Features.TRADING);
    context.openPositions = 1;
    context.perpMarkets = [nvdaiMarket];
    context.agentPositions.perps = [
      {
        ticker: 'NVDAI',
        side: 'long',
        size: 10,
        maxOrderSize: 10_000,
        minOrderSize: 10,
        pnl: 0,
        pnlPercent: 0,
        entryPrice: 100,
        currentPrice: 100,
        timeHeld: '20m',
        timeHeldMs: 1_200_000,
      },
    ];
    decision
      .mockResolvedValueOnce(perpTrade('open_short', 15))
      .mockResolvedValueOnce(likeInstead);

    expect((await executor.execute(actor.id, runtime, true)).success).toBe(
      true
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'open the remaining 5 points on the other side, below the minimum order size of 10 points'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toBe(Actions.LIKE);
  });

  test('still dispatches sells and perp closes with less than 1 point of balance', async () => {
    const executor = new MultiStepExecutor(2);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 0.5;
    context.enabledFeatures.push(Features.TRADING);
    context.openPositions = 2;
    context.agentPositions.predictions = [heldPrediction];
    context.agentPositions.perps = [
      {
        ticker: 'NVDAI',
        side: 'long',
        size: 10,
        maxOrderSize: 10_000,
        minOrderSize: 10,
        pnl: 0,
        pnlPercent: 0,
        entryPrice: 100,
        currentPrice: 100,
        timeHeld: '20m',
        timeHeldMs: 1_200_000,
      },
    ];
    decision
      .mockResolvedValueOnce({
        decision: {
          thought: 'Sell the YES side.',
          action: Actions.TRADE,
          parameters: {
            marketType: 'prediction',
            marketId: heldPrediction.marketId,
            side: 'sell_yes',
            amount: 0,
          },
          isFinish: false,
        },
        rawResponse: '{}',
      })
      .mockResolvedValueOnce(perpTrade('close_position', 0));
    execute.mockResolvedValue({
      actionType: Actions.TRADE,
      success: true,
      summary: 'Closed',
      timestamp: Date.now(),
    });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ side: 'sell_yes' }),
      expect.objectContaining({ side: 'close_position' }),
    ]);
  });

  test('gives an oversized perp order the existing correction before dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.balance = 100_000;
    context.enabledFeatures.push(Features.TRADING);
    context.perpMarkets = [
      {
        ticker: 'NVDAI',
        name: 'NVIDAI',
        currentPrice: 100,
        initialPrice: 100,
        changePercent: 0,
        maxOrderSize: 10_000,
        minOrderSize: 10,
      },
    ];
    const trade = {
      thought: 'Open a long.',
      action: Actions.TRADE,
      parameters: {
        marketType: 'perp',
        marketId: 'NVDAI',
        side: 'open_long',
        amount: 10_001,
      },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({ decision: trade, rawResponse: '{}' })
      .mockResolvedValueOnce({
        decision: {
          ...trade,
          parameters: { ...trade.parameters, amount: 10_000 },
        },
        rawResponse: '{}',
      });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[0]?.[0]).toContain(
      'Maximum order size: 10000 points'
    );
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'available size limit of 10000 points'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ amount: 10_000 });
  });

  const heldPrediction = {
    marketId: 'held-only-market',
    question: 'Will the lighthouse reopen?',
    side: 'YES',
    shares: 10,
    avgPrice: 0.5,
    currentPrice: 0.6,
    pnlPercent: 20,
    timeHeld: '20m',
    timeHeldMs: 1_200_000,
  };

  function buyPrediction(marketId: string) {
    return {
      decision: {
        thought: 'Buy the YES side.',
        action: Actions.TRADE,
        parameters: {
          marketType: 'prediction',
          marketId,
          side: 'buy_yes',
          amount: 5,
        },
        isFinish: false,
      },
      rawResponse: '{}',
    };
  }

  test('refuses a buy without a quote before dispatch and allows a later quoted buy', async () => {
    const executor = new MultiStepExecutor(2);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.enabledFeatures.push(Features.TRADING);
    context.openPositions = 1;
    context.agentPositions.predictions = [heldPrediction];
    context.predictionMarkets = [
      {
        id: 'quoted-market',
        question: 'Will the observatory reopen?',
        yesPrice: 0.6,
        noPrice: 0.4,
        volume: 100,
        maxSafeBet: 10,
        endDate: '2026-11-21T18:00:00.000Z',
      },
    ];
    decision
      .mockResolvedValueOnce(buyPrediction(heldPrediction.marketId))
      .mockResolvedValueOnce(buyPrediction(heldPrediction.marketId))
      .mockResolvedValueOnce(buyPrediction('quoted-market'));
    execute.mockResolvedValueOnce({
      actionType: Actions.TRADE,
      success: true,
      summary: 'Bought YES',
      timestamp: Date.now(),
    });

    const result = await executor.execute(actor.id, runtime, true);

    expect(decision.mock.calls[0]?.[0]).toContain(
      'A market ID shown only in Your Open Positions is for selling a held side'
    );
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'Buy only an ID under Available Prediction Markets'
    );
    expect(decision).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      marketId: 'quoted-market',
      side: 'buy_yes',
    });
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.actionsExecuted.trades).toBe(1);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.TRADE,
      success: false,
      parameters: { marketId: heldPrediction.marketId },
      result: { rejection: 'prediction-quote-unavailable' },
    });
  });

  test('a final refused buy leaves zero trades and completes the NPC tick', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      true
    );
    context.agentPositions.predictions = [heldPrediction];
    decision.mockImplementation(async () =>
      buyPrediction(heldPrediction.marketId)
    );

    const result = await executor.execute(actor.id, runtime, true);

    expect(decision).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.actionsExecuted.trades).toBe(0);
  });

  test('an unknown market ID still fails after correction without dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor, false, true);
    decision.mockImplementation(async () => buyPrediction('unknown-market'));

    await expect(executor.execute(actor.id, runtime, true)).rejects.toThrow(
      'that market is not in the current context'
    );
    expect(decision).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  test('the standalone tick still rejects a user agent before planning', async () => {
    const executor = new MultiStepExecutor(1);
    const { runtime, decision, execute } = prepare(executor, false, true);

    await expect(executor.execute(actor.id, runtime, false)).rejects.toThrow(
      'Only NPCs can execute autonomous ticks'
    );
    expect(decision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  const npcFollowTarget = StaticDataRegistry.getActor('jeff-baizos')!;
  const organizationFollowTarget =
    StaticDataRegistry.getOrganization('the-daily-wire')!;
  const npcFollowFeedback =
    'NPC actors are ineligible FOLLOW and UNFOLLOW targets';
  const organizationUnfollowFeedback =
    'Organizations are ineligible UNFOLLOW targets';

  for (const [action, target, authorKind, feedback] of [
    [Actions.FOLLOW, npcFollowTarget, 'NPC actor', npcFollowFeedback],
    [Actions.UNFOLLOW, npcFollowTarget, 'NPC actor', npcFollowFeedback],
    [
      Actions.UNFOLLOW,
      organizationFollowTarget,
      'organization',
      organizationUnfollowFeedback,
    ],
  ] as const) {
    test(`skips repeated ${action} of ${target.id} without dispatch`, async () => {
      const executor = new MultiStepExecutor(1);
      const { context, runtime, decision, execute } = prepare(executor);
      context.recentPosts.push({
        ...context.recentPosts[0]!,
        id: 'ineligible-author-post',
        authorId: target.id,
        authorName: target.name,
      });
      const rejectedAction = {
        actionType: action,
        success: false,
        summary:
          authorKind === 'organization'
            ? `User not found: ${target.id}`
            : 'NPC actors are not supported here',
        timestamp: Date.now(),
      };
      execute.mockResolvedValue(rejectedAction);
      decision.mockImplementation(async () => ({
        decision: {
          thought: 'Change who I follow.',
          action,
          parameters: { userId: target.id },
          isFinish: false,
        },
        rawResponse: '{}',
      }));

      const result = await executor.execute(actor.id, runtime, true);

      expect(decision.mock.calls[0]?.[0]).toContain(
        `(userId: ${target.id}, ${authorKind})`
      );
      expect(decision).toHaveBeenCalledTimes(2);
      expect(decision.mock.calls[1]?.[4]?.feedback).toContain(feedback);
      expect(execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.actionsExecuted.engagements).toBe(0);
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0]).toMatchObject({
        actionType: action,
        success: false,
        result: { rejection: 'social-target-unavailable' },
      });
    });
  }

  for (const [action, target, feedback] of [
    [Actions.FOLLOW, npcFollowTarget, npcFollowFeedback],
    [Actions.UNFOLLOW, npcFollowTarget, npcFollowFeedback],
    [
      Actions.FOLLOW,
      organizationFollowTarget,
      'Organizations are ineligible FOLLOW targets',
    ],
    [Actions.UNFOLLOW, organizationFollowTarget, organizationUnfollowFeedback],
  ] as const) {
    test(`corrects ${action} of ${target.id} before dispatching to an account`, async () => {
      const executor = new MultiStepExecutor(1);
      const { context, runtime, decision, execute } = prepare(executor);
      const accountPost = context.recentPosts[0]!;
      context.recentPosts.push({
        ...accountPost,
        id: 'ineligible-author-post',
        authorId: target.id,
        authorName: target.name,
      });
      const intent = {
        thought: 'Change who I follow.',
        action,
        parameters: { userId: target.id },
        isFinish: false,
      };
      decision
        .mockResolvedValueOnce({ decision: intent, rawResponse: '{}' })
        .mockResolvedValueOnce({
          decision: {
            ...intent,
            parameters: { userId: accountPost.authorId },
          },
          rawResponse: '{}',
        });

      expect((await executor.execute(actor.id, runtime, true)).success).toBe(
        true
      );
      expect(decision).toHaveBeenCalledTimes(2);
      expect(decision.mock.calls[1]?.[4]?.feedback).toContain(feedback);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe(action);
      expect(execute.mock.calls[0]?.[2]).toEqual({
        userId: accountPost.authorId,
      });
    });
  }

  test('skips repeated DM to an organization author without dispatch', async () => {
    const executor = new MultiStepExecutor(1);
    const { context, runtime, decision, execute } = prepare(
      executor,
      false,
      false,
      false,
      true
    );
    const organization = StaticDataRegistry.getOrganization('the-daily-wire')!;
    context.recentPosts.push({
      ...context.recentPosts[0]!,
      id: 'organization-post',
      authorId: organization.id,
      authorName: organization.name,
    });
    execute.mockResolvedValue({
      actionType: Actions.DM,
      success: false,
      summary: `Recipient not found: ${organization.id}`,
      timestamp: Date.now(),
    });
    decision.mockImplementation(async () => ({
      decision: {
        thought: 'Ask the author a question.',
        action: Actions.DM,
        parameters: {
          recipientId: organization.id,
          content: 'What do you think about this?',
        },
        isFinish: false,
      },
      rawResponse: '{}',
    }));

    const result = await executor.execute(actor.id, runtime, true);

    expect(decision).toHaveBeenCalledTimes(2);
    expect(decision.mock.calls[1]?.[4]?.feedback).toContain(
      'Choose a user, agent, or NPC'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.actionsExecuted.messages).toBe(0);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.DM,
      success: false,
      result: { rejection: 'social-target-unavailable' },
    });
  });

  test('an offered clue takes the only POST slot even if its publication is stale', async () => {
    spyOn(Math, 'random').mockReturnValue(0.5);
    const executor = new MultiStepExecutor(2);
    const { context, gameContext, runtime, decision, execute } = prepare(
      executor,
      true
    );
    execute.mockRestore();
    gameContext.mockImplementation(async (_actorId, publicOnly) =>
      publicOnly ? 'Public world fact canary' : 'Private outcome canary'
    );
    context.pendingChatMessages = [
      {
        id: 'dm-1',
        chatId: 'private-chat',
        chatName: 'Private DM',
        isGroupChat: false,
        author: 'Other',
        content: 'Private DM canary',
        recentMessages: [],
        formattedContext: 'Private DM canary',
        timestamp: new Date(),
      },
    ];
    context.groupChats = [{ id: 'group-1', name: 'Private group name canary' }];
    context.groupChatIntel = [
      {
        chatName: 'Private group chat',
        summary: 'Private group intel canary',
        keyFacts: [],
        recentMessages: [],
      },
    ];
    context.contextRefreshSummary = 'Private context refresh canary';
    context.narrativeContext = {
      resolvedQuestions: '',
      recentTrades: '',
      eventSignals: 'Private event signal canary',
    };
    const publish = spyOn(
      directExecutors,
      'executeDirectPost'
    ).mockResolvedValue({
      success: true,
      marketClueStatus: 'stale',
    });
    const now = new Date();
    const clue: NpcMarketClue = {
      actorId: actor.id,
      gameId: 'game-1',
      marketId: 'market-1',
      questionId: 'question-1',
      frameId: 'frame-1',
      phase: 'live',
      phaseEnteredAt: now,
      oldestPendingAt: now,
      question: 'Will the lighthouse reopen?',
    };
    const postDecision = {
      thought: 'Post an update about the lighthouse.',
      action: Actions.POST,
      parameters: { content: 'Watch for a new beacon scan tonight.' },
      isFinish: false,
    };
    decision
      .mockResolvedValueOnce({
        decision: { ...postDecision },
        rawResponse: '{}',
      })
      .mockResolvedValueOnce({
        decision: { ...postDecision },
        rawResponse: '{}',
      })
      .mockResolvedValueOnce({
        decision: {
          thought: 'Finish',
          action: Actions.FINISH,
          parameters: {},
          isFinish: true,
        },
        rawResponse: '{}',
      });

    const result = await executor.execute(
      actor.id,
      runtime,
      true,
      undefined,
      clue
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].marketClue).toBe(clue);
    expect(result.actionsExecuted.posts).toBe(0);
    expect(decision.mock.calls[0]?.[0]).toContain(
      'A market update is due for this question:'
    );
    expect(decision.mock.calls[0]?.[0]).toContain('Public world fact canary');
    expect(decision.mock.calls[0]?.[0]).toContain('An actionable post');
    expect(decision.mock.calls[0]?.[0]).not.toMatch(/Private .* canary/);
    expect(gameContext.mock.calls[0]).toEqual([actor.id, true]);
    expect(decision.mock.calls[1]?.[0]).toContain('Private outcome canary');
    expect(decision.mock.calls[1]?.[0]).not.toContain(
      'A market update is due for this question:'
    );
    expect(decision.mock.calls[2]?.[4]?.feedback).toContain(
      'feature "posting" is disabled'
    );
  });

  test('a rejected post stays in the trace while a later step publishes a fresh post', async () => {
    spyOn(Math, 'random').mockReturnValue(0.5);
    const executor = new MultiStepExecutor(2);
    const { runtime, decision, execute } = prepare(executor, true);
    execute.mockRestore();
    const publish = spyOn(directExecutors, 'executeDirectPost')
      .mockResolvedValueOnce({
        success: false,
        rejection: 'post-diversity',
        error: 'Content rejected: Content is 42% similar to a recent post.',
      })
      .mockResolvedValueOnce({ success: true, postId: 'fresh-post' });
    for (const content of ['A recycled take', 'A new telescope observation']) {
      decision.mockResolvedValueOnce({
        decision: {
          thought: 'Post an update.',
          action: Actions.POST,
          parameters: { content },
          isFinish: false,
        },
        rawResponse: '{}',
      });
    }

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.actionsExecuted.posts).toBe(1);
    expect(result.trace[0]).toMatchObject({
      actionType: Actions.POST,
      success: false,
      result: { rejection: 'post-diversity' },
    });
    expect(result.trace[1]?.result?.postId).toBe('fresh-post');
    expect(decision.mock.calls[1]?.[0]).toContain(
      'Post rejected by diversity checks'
    );
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test('ordinary POST failures still fail the tick', async () => {
    spyOn(Math, 'random').mockReturnValue(0.5);
    const executor = new MultiStepExecutor(2);
    const { runtime, decision, execute } = prepare(executor, true);
    execute.mockRestore();
    spyOn(directExecutors, 'executeDirectPost').mockResolvedValue({
      success: false,
      error: 'Database unavailable',
    });
    decision.mockResolvedValueOnce({
      decision: {
        thought: 'Post an update.',
        action: Actions.POST,
        parameters: { content: 'A new telescope observation' },
        isFinish: false,
      },
      rawResponse: '{}',
    });

    await expect(executor.execute(actor.id, runtime, true)).rejects.toThrow(
      'Agent action POST failed: Post failed: Database unavailable'
    );
    expect(decision).toHaveBeenCalledTimes(1);
  });

  test('diversity rejections cannot extend the four-step budget or count as publications', async () => {
    spyOn(Math, 'random').mockReturnValue(0.5);
    const executor = new MultiStepExecutor();
    const { runtime, decision, execute } = prepare(executor, true);
    execute.mockRestore();
    const publish = spyOn(
      directExecutors,
      'executeDirectPost'
    ).mockResolvedValue({
      success: false,
      rejection: 'post-diversity',
      error: 'Content rejected: Content is too similar to a recent post.',
    });
    decision.mockResolvedValue({
      decision: {
        thought: 'Post an update.',
        action: Actions.POST,
        parameters: { content: 'A recycled take' },
        isFinish: false,
      },
      rawResponse: '{}',
    });

    const result = await executor.execute(actor.id, runtime, true);

    expect(result.success).toBe(true);
    expect(result.actionsExecuted.posts).toBe(0);
    expect(result.trace).toHaveLength(4);
    expect(result.trace.every((action) => !action.success)).toBe(true);
    expect(decision).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(4);
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
