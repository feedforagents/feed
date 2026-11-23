import { describe, expect, test } from 'bun:test';
import { MultiStepExecutor } from '../MultiStepExecutor';
import { normalizeSocialDecisionParameters } from '../social-parameter-normalization';
import {
  Actions,
  type AgentTickContext,
  Features,
} from '../templates/multi-step-decision';

function createContext(): AgentTickContext {
  return {
    balance: 1000,
    pnl: 0,
    openPositions: 0,
    pendingCommentReplies: [
      {
        id: 'comment-pending',
        postId: 'post-pending',
        author: 'bob',
        content: 'What do you think of this move?',
        post: {
          id: 'post-pending',
          content: 'Breaking analysis on perp funding rates',
          authorName: 'bob',
          isYourPost: false,
        },
        thread: [],
        formattedContext: 'bob: What do you think of this move?',
        timestamp: new Date('2026-11-22T00:00:00.000Z'),
      },
    ],
    pendingChatMessages: [
      {
        id: 'msg-1',
        chatId: 'chat-pending',
        chatName: 'DM with Bob',
        isGroupChat: false,
        author: 'bob',
        content: 'Quick question on your position',
        recentMessages: [],
        formattedContext: 'bob: Quick question on your position',
        timestamp: new Date('2026-11-22T00:00:00.000Z'),
      },
    ],
    enabledFeatures: [
      Features.COMMENTING,
      Features.ENGAGING,
      Features.DMS,
      Features.GROUP_CHATS,
    ],
    predictionMarkets: [],
    perpMarkets: [],
    recentPosts: [
      {
        id: 'post-1',
        authorId: 'user-1',
        authorName: 'alpha',
        content: 'first post',
        commentCount: 2,
        likeCount: 5,
        repostCount: 1,
        timeAgo: '1m',
      },
    ],
    agentPositions: {
      predictions: [],
      perps: [],
    },
    groupChats: [
      {
        id: 'group-1',
        name: 'Alpha Desk',
        memberCount: 4,
      },
    ],
    socialGraph: [
      {
        userId: 'alice-trader',
        displayName: 'Alice Trader',
        username: 'alice',
        isFollowing: true,
        isFollowedBy: true,
        interactionCount: 3,
      },
      {
        userId: 'agent-self',
        displayName: 'Self',
        username: 'self',
        isFollowing: false,
        isFollowedBy: false,
        interactionCount: 1,
      },
    ],
  };
}

function validateAction(
  action: string,
  parameters: Record<string, unknown>,
  context: AgentTickContext
): string | undefined {
  const executor = new MultiStepExecutor(1);
  return executor['getDecisionValidationError'](action, parameters, context);
}

describe('normalizeSocialDecisionParameters with prompt-rendered targets', () => {
  test('resolves LIKE and REPOST targeting a post present only in pendingCommentReplies', () => {
    const context = createContext();

    const exactLike = normalizeSocialDecisionParameters(
      Actions.LIKE,
      { postId: 'post-pending' },
      context,
      'agent-self'
    );
    expect(exactLike).toEqual({ postId: 'post-pending' });
    expect(validateAction(Actions.LIKE, exactLike, context)).toBeUndefined();

    const promptLineRepost = normalizeSocialDecisionParameters(
      Actions.REPOST,
      {
        postId: 'commentId: comment-pending | postId: post-pending',
        comment: 'Good catch',
      },
      context,
      'agent-self'
    );
    expect(promptLineRepost).toEqual({
      postId: 'post-pending',
      comment: 'Good catch',
    });
    expect(
      validateAction(Actions.REPOST, promptLineRepost, context)
    ).toBeUndefined();

    const prefersPostIdOverId = normalizeSocialDecisionParameters(
      Actions.LIKE,
      { postId: 'id: post-1 | postId: post-pending' },
      context,
      'agent-self'
    );
    expect(prefersPostIdOverId).toEqual({ postId: 'post-pending' });

    const commentIgnoresPendingReplyOnlyPost =
      normalizeSocialDecisionParameters(
        Actions.COMMENT,
        { postId: 'post-pending', content: 'Top level' },
        context,
        'agent-self'
      );
    expect(commentIgnoresPendingReplyOnlyPost).toEqual({
      content: 'Top level',
    });
  });

  test('does not resolve out-of-range recent-post or author ordinals onto fallback pools', () => {
    const context = createContext();

    const outOfRangeLike = normalizeSocialDecisionParameters(
      Actions.LIKE,
      { postId: '#2' },
      context,
      'agent-self'
    );
    expect(outOfRangeLike).toEqual({});
    expect(validateAction(Actions.LIKE, outOfRangeLike, context)).toBeDefined();

    const outOfRangeFollow = normalizeSocialDecisionParameters(
      Actions.FOLLOW,
      { userId: '#2' },
      context,
      'agent-self'
    );
    expect(outOfRangeFollow).toEqual({});
    expect(
      validateAction(Actions.FOLLOW, outOfRangeFollow, context)
    ).toBeDefined();
  });

  test('unwraps quoted chatId copied verbatim from pending chats and group chats', () => {
    const context = createContext();

    const quotedReply = normalizeSocialDecisionParameters(
      Actions.REPLY_CHAT,
      { chatId: 'id: msg-1 | chatId: "chat-pending"', content: 'On it' },
      context,
      'agent-self'
    );
    expect(quotedReply).toEqual({
      chatId: 'chat-pending',
      content: 'On it',
    });
    expect(
      validateAction(Actions.REPLY_CHAT, quotedReply, context)
    ).toBeUndefined();

    const singleQuotedReply = normalizeSocialDecisionParameters(
      Actions.REPLY_CHAT,
      { chatId: "chatId: 'chat-pending'", content: 'On it' },
      context,
      'agent-self'
    );
    expect(singleQuotedReply).toEqual({
      chatId: 'chat-pending',
      content: 'On it',
    });

    const quotedGroup = normalizeSocialDecisionParameters(
      Actions.GROUP_MESSAGE,
      {
        chatId: '- chatId: "group-1" | groupId: g-1 | Alpha Desk | members: 4',
        content: 'Heads up',
      },
      context,
      'agent-self'
    );
    expect(quotedGroup).toEqual({
      chatId: 'group-1',
      content: 'Heads up',
    });
    expect(
      validateAction(Actions.GROUP_MESSAGE, quotedGroup, context)
    ).toBeUndefined();

    const fallbackIdGroup = normalizeSocialDecisionParameters(
      Actions.GROUP_MESSAGE,
      { chatId: '(id: group-1)', content: 'Heads up' },
      context,
      'agent-self'
    );
    expect(fallbackIdGroup).toEqual({
      chatId: 'group-1',
      content: 'Heads up',
    });

    const unknownQuoted = normalizeSocialDecisionParameters(
      Actions.REPLY_CHAT,
      { chatId: 'chatId: "chat-unknown"', content: 'On it' },
      context,
      'agent-self'
    );
    expect(unknownQuoted).toEqual({ content: 'On it' });
    expect(
      validateAction(Actions.REPLY_CHAT, unknownQuoted, context)
    ).toBeDefined();
  });

  test('extracts action-appropriate fields from multi-id prompt excerpts and supports id fallback', () => {
    const context = createContext();
    const recentPostExcerpt =
      '- Post #1 (id: post-1) @alpha (userId: user-1, NPC actor) (1m): "first post"';

    const comment = normalizeSocialDecisionParameters(
      Actions.COMMENT,
      { postId: recentPostExcerpt, content: 'Agree on this setup' },
      context,
      'agent-self'
    );
    expect(comment).toEqual({
      postId: 'post-1',
      content: 'Agree on this setup',
    });
    expect(validateAction(Actions.COMMENT, comment, context)).toBeUndefined();

    const dm = normalizeSocialDecisionParameters(
      Actions.DM,
      { recipientId: recentPostExcerpt, content: 'Nice call' },
      context,
      'agent-self'
    );
    expect(dm).toEqual({ recipientId: 'user-1', content: 'Nice call' });
    expect(validateAction(Actions.DM, dm, context)).toBeUndefined();

    const dmRecipientField = normalizeSocialDecisionParameters(
      Actions.DM,
      {
        recipientId: 'userId: user-1 | recipientId: "alice-trader"',
        content: 'Direct check-in',
      },
      context,
      'agent-self'
    );
    expect(dmRecipientField).toEqual({
      recipientId: 'alice-trader',
      content: 'Direct check-in',
    });

    const dmIdFallback = normalizeSocialDecisionParameters(
      Actions.DM,
      { recipientId: '(id: user-1)', content: 'Fallback check' },
      context,
      'agent-self'
    );
    expect(dmIdFallback).toEqual({
      recipientId: 'user-1',
      content: 'Fallback check',
    });

    const follow = normalizeSocialDecisionParameters(
      Actions.FOLLOW,
      { userId: recentPostExcerpt },
      context,
      'agent-self'
    );
    expect(follow).toEqual({ userId: 'user-1' });
    expect(validateAction(Actions.FOLLOW, follow, context)).toBeUndefined();

    const unfollowIdFallback = normalizeSocialDecisionParameters(
      Actions.UNFOLLOW,
      { userId: '(id: alice-trader)' },
      context,
      'agent-self'
    );
    expect(unfollowIdFallback).toEqual({ userId: 'alice-trader' });
    expect(
      validateAction(Actions.UNFOLLOW, unfollowIdFallback, context)
    ).toBeUndefined();
  });

  test('resolves non-digit socialGraph userIds for DM and FOLLOW while excluding self and unknown text', () => {
    const context = createContext();

    const dmExact = normalizeSocialDecisionParameters(
      Actions.DM,
      { recipientId: 'alice-trader', content: 'Checking in' },
      context,
      'agent-self'
    );
    expect(dmExact).toEqual({
      recipientId: 'alice-trader',
      content: 'Checking in',
    });
    expect(validateAction(Actions.DM, dmExact, context)).toBeUndefined();

    const followPromptLine = normalizeSocialDecisionParameters(
      Actions.FOLLOW,
      { userId: '@alice (mutual) (userId: alice-trader)' },
      context,
      'agent-self'
    );
    expect(followPromptLine).toEqual({ userId: 'alice-trader' });
    expect(
      validateAction(Actions.FOLLOW, followPromptLine, context)
    ).toBeUndefined();

    const selfTarget = normalizeSocialDecisionParameters(
      Actions.DM,
      { recipientId: 'agent-self', content: 'Note to self' },
      context,
      'agent-self'
    );
    expect(selfTarget).toEqual({ content: 'Note to self' });

    const unknownText = normalizeSocialDecisionParameters(
      Actions.DM,
      { recipientId: 'unknown-person', content: 'Hi' },
      context,
      'agent-self'
    );
    expect(unknownText).toEqual({ content: 'Hi' });
  });

  test('extracts commentId rather than postId for REPLY_COMMENT and supports id fallback', () => {
    const context = createContext();

    const reply = normalizeSocialDecisionParameters(
      Actions.REPLY_COMMENT,
      {
        commentId:
          'id: post-pending | postId: post-pending | commentId: comment-pending',
        content: 'Good question',
      },
      context,
      'agent-self'
    );
    expect(reply).toEqual({
      commentId: 'comment-pending',
      postId: 'post-pending',
      content: 'Good question',
    });
    expect(
      validateAction(Actions.REPLY_COMMENT, reply, context)
    ).toBeUndefined();

    const replyIdFallback = normalizeSocialDecisionParameters(
      Actions.REPLY_COMMENT,
      {
        commentId: '(id: comment-pending)',
        content: 'Good question',
      },
      context,
      'agent-self'
    );
    expect(replyIdFallback).toEqual({
      commentId: 'comment-pending',
      postId: 'post-pending',
      content: 'Good question',
    });
  });
});
