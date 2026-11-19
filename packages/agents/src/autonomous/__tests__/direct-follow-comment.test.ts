import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mutable canned rows for the mocked drizzle-style db. Each select() call
// branches on the table passed to from() and the keys of the select shape,
// mirroring how executeDirectFollow / executeDirectComment query each table.
let mockTargetUser: { id: string; isActor: boolean } | null = {
  id: 'user-2',
  isActor: false,
};
let mockPost: {
  id: string;
  authorId: string;
  deletedAt: Date | null;
} | null = { id: 'post-1', authorId: 'user-2', deletedAt: null };
let mockExistingComment: { id: string } | null = null;
let mockParentComment: { id: string; deletedAt: Date | null } | null = null;
let mockFollowInsertResult: Array<{ id: string }> = [{ id: 'follow-1' }];
let commentsSelectCount = 0;

const blockedPairs = new Set<string>();

const followInsertMock = mock(() => undefined);
const commentInsertMock = mock(() => undefined);

const usersTable = {
  __t: 'users',
  id: 'u.id',
  managedBy: 'u.managedBy',
  isActor: 'u.isActor',
  displayName: 'u.displayName',
};
const postsTable = {
  __t: 'posts',
  id: 'p.id',
  authorId: 'p.authorId',
  content: 'p.content',
  deletedAt: 'p.deletedAt',
  originalPostId: 'p.originalPostId',
};
const commentsTable = {
  __t: 'comments',
  id: 'c.id',
  authorId: 'c.authorId',
  postId: 'c.postId',
  parentCommentId: 'c.parentCommentId',
  deletedAt: 'c.deletedAt',
};
const followsTable = {
  __t: 'follows',
  id: 'f.id',
  followerId: 'f.followerId',
  followingId: 'f.followingId',
};

function resolveSelect(
  table: { __t: string } | null,
  shape: Record<string, unknown>
): unknown[] {
  const keys = Object.keys(shape);
  if (table === usersTable) {
    if (keys.includes('displayName')) return [{ displayName: 'Agent One' }];
    if (keys.includes('isActor')) return mockTargetUser ? [mockTargetUser] : [];
    return [];
  }
  if (table === postsTable) {
    return mockPost ? [mockPost] : [];
  }
  if (table === commentsTable) {
    // Parent-comment lookup selects deletedAt; the dedup lookup selects
    // only { id }. On the unfixed code both select { id }, so the second
    // comments select in a reply is the parent lookup.
    if (keys.includes('deletedAt')) {
      return mockParentComment ? [mockParentComment] : [];
    }
    commentsSelectCount += 1;
    if (commentsSelectCount === 1) {
      return mockExistingComment ? [mockExistingComment] : [];
    }
    return mockParentComment ? [mockParentComment] : [];
  }
  return [];
}

const mockDb = {
  select: (shape: Record<string, unknown>) => {
    let table: { __t: string } | null = null;
    const chain: Record<string, unknown> = {
      from: (t: { __t: string }) => {
        table = t;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: async () => resolveSelect(table, shape),
      then: (
        resolve: (value: unknown[]) => void,
        reject: (reason: unknown) => void
      ) => Promise.resolve(resolveSelect(table, shape)).then(resolve, reject),
    };
    return chain;
  },
  insert: (table: { __t: string }) => ({
    values: (..._args: unknown[]) => {
      if (table === followsTable) {
        followInsertMock();
        return {
          onConflictDoNothing: () => ({
            returning: async () => mockFollowInsertResult,
          }),
        };
      }
      commentInsertMock();
      return Promise.resolve(undefined);
    },
  }),
  delete: mock(() => ({
    where: mock(() => ({
      returning: mock(async () => []),
    })),
  })),
};

mock.module('@feed/db', () => ({
  actorState: { __t: 'actorState', id: 'a.id' },
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: { __t: 'chatParticipants' },
  chats: { __t: 'chats' },
  comments: commentsTable,
  db: mockDb,
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: followsTable,
  groupMembers: {},
  groups: {},
  gte: (...args: unknown[]) => args,
  hasBlocked: mock(async (blockerId: string, blockedId: string) =>
    blockedPairs.has(`${blockerId}:${blockedId}`)
  ),
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: postsTable,
  reactions: {},
  shares: { id: 'id', postId: 'postId', userId: 'userId' },
  sql: {},
  users: usersTable,
}));

mock.module('@feed/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: {
    invalidateUserCache: mock(async () => undefined),
  },
  notifyGroupChatMessage: async () => undefined,
}));

mock.module('@feed/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {},
}));

mock.module('@feed/core/markets/prediction', () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {},
}));

mock.module('@feed/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: {},
  },
  FeeService: { processTradingFee: mock(async () => ({ feeCharged: 0 })) },
  generateTagsFromPost: mock(async () => []),
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {},
  createNpcWalletAdapter: mock(() => ({})),
  createPerpPriceImpactPort: mock(() => ({})),
  createPerpSettlement: mock(() => ({})),
  createPerpTradesCachePort: mock(() => ({})),
  StaticDataRegistry: { getActor: mock(() => null) },
  storeTagsForPost: mock(async () => undefined),
  WalletService: class {},
  withPredictionSettlement: mock(async () => undefined),
}));

mock.module('@feed/shared', () => ({
  floorPoints: mock(() => 0),
  isPureRepost: mock(() => false),
}));

mock.module('../../shared/logger', () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module('../../shared/snowflake', () => ({
  generateSnowflakeId: mock(async () => 'snowflake-id'),
}));

mock.module('../../services/AgentPnLService', () => ({
  agentPnLService: { recordTrade: mock(async () => undefined) },
}));

mock.module('../TopicDiversityService', () => ({
  topicDiversityService: { trackPostTopics: mock(async () => undefined) },
}));

mock.module('../utils/resolvePerpTicker', () => ({
  resolvePerpTicker: mock(() => null),
}));

const { executeDirectComment, executeDirectFollow } = await import(
  '../DirectExecutors'
);

describe('executeDirectFollow moderation', () => {
  beforeEach(() => {
    mockTargetUser = { id: 'user-2', isActor: false };
    mockFollowInsertResult = [{ id: 'follow-1' }];
    blockedPairs.clear();
    followInsertMock.mockClear();
    commentInsertMock.mockClear();
  });

  test('rejects a follow when the target has blocked the agent', async () => {
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'user-2',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot follow this user');
    expect(followInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a follow when the agent has blocked the target', async () => {
    blockedPairs.add('agent-1:user-2');

    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'user-2',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot follow this user');
    expect(followInsertMock).not.toHaveBeenCalled();
  });

  test('follows an unblocked user', async () => {
    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'user-2',
    });

    expect(result.success).toBe(true);
    expect(result.followed).toBe(true);
    expect(followInsertMock).toHaveBeenCalled();
  });
});

describe('executeDirectComment moderation', () => {
  beforeEach(() => {
    mockPost = { id: 'post-1', authorId: 'user-2', deletedAt: null };
    mockExistingComment = null;
    mockParentComment = null;
    commentsSelectCount = 0;
    blockedPairs.clear();
    followInsertMock.mockClear();
    commentInsertMock.mockClear();
  });

  test('rejects a comment on a soft-deleted post', async () => {
    mockPost = { id: 'post-1', authorId: 'user-2', deletedAt: new Date() };

    const result = await executeDirectComment({
      agentUserId: 'agent-1',
      postId: 'post-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot comment on deleted post');
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a comment when the post author blocked the agent', async () => {
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectComment({
      agentUserId: 'agent-1',
      postId: 'post-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot comment on this post');
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a comment when the agent blocked the post author', async () => {
    blockedPairs.add('agent-1:user-2');

    const result = await executeDirectComment({
      agentUserId: 'agent-1',
      postId: 'post-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot comment on this post');
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a reply when the parent comment is soft-deleted', async () => {
    mockParentComment = { id: 'comment-9', deletedAt: new Date() };

    const result = await executeDirectComment({
      agentUserId: 'agent-1',
      postId: 'post-1',
      content: 'hello there',
      parentCommentId: 'comment-9',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Parent comment not found');
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  test('comments on a live post by an unblocked author', async () => {
    const result = await executeDirectComment({
      agentUserId: 'agent-1',
      postId: 'post-1',
      content: 'hello there',
    });

    expect(result.success).toBe(true);
    expect(result.commentId).toBe('snowflake-id');
    expect(commentInsertMock).toHaveBeenCalled();
  });
});
