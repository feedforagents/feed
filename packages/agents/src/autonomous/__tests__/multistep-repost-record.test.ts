/**
 * Regression: executeDirectRepost succeeds idempotently when the share
 * already exists. Its result must identify that case, and the multi-step
 * executor's record — the agent log message and the trace summary fed back
 * into the next decision prompt — must say the post was already reposted,
 * mirroring how executeFollow distinguishes "Now following" from "Already
 * following", instead of claiming a new repost happened.
 */
import { describe, expect, mock, test } from 'bun:test';

const createLogCalls: Array<Record<string, unknown>> = [];
let repostResult: {
  success: boolean;
  repostId?: string;
  quotePostId?: string;
  alreadyReposted?: boolean;
  error?: string;
} = {
  success: true,
  repostId: 'share-existing',
  alreadyReposted: true,
};

mock.module('@feed/db', () => ({
  actorState: {},
  agentLogs: {},
  and: (...args: unknown[]) => args,
  chats: {},
  db: {},
  desc: (x: unknown) => x,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  gte: (...args: unknown[]) => args,
  npcTrades: {},
  questions: {},
  users: {},
}));

mock.module('@feed/engine', () => ({
  countTokensSync: () => 0,
  generateWorldContext: mock(async () => ({})),
  getSafeContextLimit: () => 1000,
  StaticDataRegistry: { getActor: () => undefined, getAllActors: () => [] },
  WalletService: { getBalance: mock(async () => ({ balance: 0 })) },
}));

mock.module('@feed/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  broadcastTypingIndicator: mock(async () => undefined),
  cachedDb: { invalidateUserCache: mock(async () => undefined) },
  checkProgress: mock(async () => undefined),
  countTokensSync: () => 0,
  createNotification: mock(async () => undefined),
  DistributedLockService: {
    acquireLock: mock(async () => true),
    releaseLock: mock(async () => undefined),
    renewLock: mock(async () => true),
    checkLock: mock(async () => null),
  },
  getCacheOrFetch: mock(async (_k: string, fn: () => unknown) => fn()),
  getModelTokenLimit: () => 100000,
  truncateToTokenLimitSync: (s: string) => s,
  verifyApiKey: mock(async () => null),
}));

const stub = mock(async () => ({ success: false, error: 'stub' }));
mock.module('../DirectExecutors', () => ({
  executeDirectComment: stub,
  executeDirectCreateGroup: stub,
  executeDirectFollow: stub,
  executeDirectInviteToGroup: stub,
  executeDirectKickFromGroup: stub,
  executeDirectLeaveGroup: stub,
  executeDirectLike: stub,
  executeDirectMessage: stub,
  executeDirectPost: stub,
  executeDirectRepost: mock(async () => repostResult),
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

describe('multi-step REPOST record', () => {
  test('records an already-existing repost as already reposted, not as a new repost', async () => {
    createLogCalls.length = 0;
    repostResult = {
      success: true,
      repostId: 'share-existing',
      alreadyReposted: true,
    };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeRepost('agent-1', {
      postId: 'post-9',
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Already reposted post-9');
    expect(result.result).toMatchObject({
      success: true,
      repostId: 'share-existing',
      alreadyReposted: true,
    });
    expect(createLogCalls[0]?.message).toBe('Already reposted post-9');
    expect(createLogCalls[0]?.metadata).toMatchObject({
      success: true,
      repostId: 'share-existing',
      alreadyReposted: true,
    });
  });

  test('does not claim a comment was added when a quote attempt hits an existing repost', async () => {
    createLogCalls.length = 0;
    repostResult = {
      success: true,
      repostId: 'share-existing',
      alreadyReposted: true,
    };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeRepost('agent-1', {
      postId: 'post-9',
      comment: 'A new take',
    });
    expect(result.summary).toBe('Already reposted post-9');
    expect(result.result.quotePostId).toBeUndefined();
    expect(createLogCalls[0]?.message).toBe('Already reposted post-9');
  });

  test('records a new repost when one was created', async () => {
    createLogCalls.length = 0;
    repostResult = {
      success: true,
      repostId: 'share-new',
      quotePostId: 'quote-1',
      alreadyReposted: false,
    };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeRepost('agent-1', {
      postId: 'post-9',
      comment: 'A new take',
    });
    expect(result.summary).toBe('Reposted post-9 with comment');
    expect(result.result).toMatchObject({
      repostId: 'share-new',
      quotePostId: 'quote-1',
      alreadyReposted: false,
    });
    expect(createLogCalls[0]?.message).toBe('Reposted post-9 with comment');
  });

  test('reachability: a postId rendered in Pending Comment Replies bypasses the already-reposted validation', async () => {
    const context = {
      recentPosts: [],
      pendingCommentReplies: [{ id: 'comment-1', postId: 'post-9' }],
      pendingChatMessages: [],
      groupChats: [],
    };
    const normalized = normalizeSocialDecisionParameters(
      'REPOST',
      { postId: 'post-9' },
      context as never,
      'agent-1'
    );
    expect(normalized).toEqual({ postId: 'post-9' });

    const executor = new MultiStepExecutor();
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        'REPOST',
        normalized,
        context as never
      )
    ).toBeUndefined();

    createLogCalls.length = 0;
    repostResult = {
      success: true,
      repostId: 'share-existing',
      alreadyReposted: true,
    };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeRepost('agent-1', normalized);
    expect(result.summary).toBe('Already reposted post-9');
    expect(createLogCalls[0]?.message).toBe('Already reposted post-9');
  });

  test('records a failed repost as a failure', async () => {
    createLogCalls.length = 0;
    repostResult = { success: false, error: 'Post not found: post-9' };
    const executor = new MultiStepExecutor();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
    const result = await (executor as any).executeRepost('agent-1', {
      postId: 'post-9',
    });
    expect(result.success).toBe(false);
    expect(result.summary).toBe('Repost failed: Post not found: post-9');
    expect(createLogCalls[0]?.message).toBe(
      'Repost failed: Post not found: post-9'
    );
    expect(createLogCalls[0]?.level).toBe('warn');
  });
});
