/**
 * Regression: executeDirectLike succeeds idempotently when the like already
 * exists (liked=false, no new reaction row). The multi-step executor's
 * record — the agent log message and the trace summary fed back into the
 * next decision prompt — must say the post was already liked, mirroring how
 * executeFollow distinguishes "Now following" from "Already following",
 * instead of claiming a new like happened.
 */
import { describe, expect, mock, test } from 'bun:test';

const createLogCalls: Array<Record<string, unknown>> = [];
let likeResult: { success: boolean; liked?: boolean; error?: string } = {
  success: true,
  liked: false,
};

// Mock only action execution and log persistence. Real dependency exports keep
// this fixture compatible with the executor without invoking model inference.
const stub = mock(async () => ({ success: false, error: 'stub' }));
mock.module('../DirectExecutors', () => ({
  executeDirectComment: stub,
  executeDirectCreateGroup: stub,
  executeDirectFollow: stub,
  executeDirectInviteToGroup: stub,
  executeDirectKickFromGroup: stub,
  executeDirectLeaveGroup: stub,
  executeDirectLike: mock(async () => likeResult),
  executeDirectMessage: stub,
  executeDirectPost: stub,
  executeDirectRepost: stub,
  executeDirectSendMoney: stub,
  executeDirectTrade: stub,
  executeDirectUnfollow: stub,
}));

mock.module('../../services/AgentService', () => ({
  agentService: {
    createLog: mock(async (_agentId: string, log: Record<string, unknown>) => {
      createLogCalls.push(log);
    }),
  },
}));

const { MultiStepExecutor } = await import('../MultiStepExecutor');
const { normalizeSocialDecisionParameters } = await import(
  '../social-parameter-normalization'
);

describe('multi-step LIKE record', () => {
  test('records an already-existing like as already liked, not as a new like', async () => {
    createLogCalls.length = 0;
    likeResult = { success: true, liked: false };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeLike('agent-1', {
      postId: 'post-9',
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Already liked post post-9');
    expect(createLogCalls[0]?.message).toBe('Already liked post post-9');
    expect(createLogCalls[0]?.metadata).toMatchObject({
      success: true,
      liked: false,
    });
  });

  test('records a new like when one was created', async () => {
    createLogCalls.length = 0;
    likeResult = { success: true, liked: true };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeLike('agent-1', {
      postId: 'post-9',
    });
    expect(result.summary).toBe('Liked post post-9');
    expect(createLogCalls[0]?.message).toBe('Liked post post-9');
  });

  test('reachability: a postId rendered in Pending Comment Replies bypasses the already-liked validation', async () => {
    // The decision prompt renders `postId: <id>` for every pending comment
    // reply (formatPendingCommentReplies) — including posts the agent
    // commented on, and may already have liked, in an earlier tick. Such a
    // post need not be in this tick's recentPosts, where validation looks.
    const context = {
      recentPosts: [],
      pendingCommentReplies: [{ id: 'comment-1', postId: 'post-9' }],
      pendingChatMessages: [],
      groupChats: [],
    };
    const normalized = normalizeSocialDecisionParameters(
      'LIKE',
      { postId: 'post-9' },
      context as never,
      'agent-1'
    );
    // The well-formed ID passes normalization unchanged…
    expect(normalized).toEqual({ postId: 'post-9' });

    const executor = new MultiStepExecutor();
    // …validation cannot reject it (the post is not in recentPosts)…
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        'LIKE',
        normalized,
        context as never
      )
    ).toBeUndefined();

    // …and execution reaches the idempotent direct like, whose result the
    // record must describe honestly.
    createLogCalls.length = 0;
    likeResult = { success: true, liked: false };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeLike('agent-1', normalized);
    expect(result.summary).toBe('Already liked post post-9');
    expect(createLogCalls[0]?.message).toBe('Already liked post post-9');
  });

  test('records a failed like as a failure', async () => {
    createLogCalls.length = 0;
    likeResult = { success: false, error: 'Post not found: post-9' };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeLike('agent-1', {
      postId: 'post-9',
    });
    expect(result.success).toBe(false);
    expect(result.summary).toBe('Like failed: Post not found: post-9');
    expect(createLogCalls[0]?.message).toBe(
      'Like failed: Post not found: post-9'
    );
    expect(createLogCalls[0]?.level).toBe('warn');
  });
});
