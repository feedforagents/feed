import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mutable canned rows for the mocked drizzle-style db. Each select() call
// on the posts table returns the requested post first, then the resolved
// original post when the requested post is a pure repost, mirroring how
// executeDirectLike / executeDirectRepost query the table.
let mockPost: {
  id: string;
  authorId: string;
  content: string;
  originalPostId: string | null;
  deletedAt: Date | null;
} | null = {
  id: 'post-1',
  authorId: 'user-2',
  content: 'hello world',
  originalPostId: null,
  deletedAt: null,
};
let mockOriginalPost: {
  id: string;
  authorId: string;
  content: string;
  originalPostId: string | null;
  deletedAt: Date | null;
} | null = null;
let postsSelectCount = 0;

const blockedPairs = new Set<string>();

const likeInsertMock = mock(() => undefined);
const shareInsertMock = mock(() => undefined);

const postsTable = {
  __t: 'posts',
  id: 'p.id',
  authorId: 'p.authorId',
  content: 'p.content',
  deletedAt: 'p.deletedAt',
  originalPostId: 'p.originalPostId',
};
const reactionsTable = {
  __t: 'reactions',
  id: 'r.id',
  postId: 'r.postId',
  userId: 'r.userId',
  type: 'r.type',
};
const sharesTable = {
  __t: 'shares',
  id: 's.id',
  postId: 's.postId',
  userId: 's.userId',
};

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
      limit: async () => {
        if (table === postsTable) {
          postsSelectCount += 1;
          if (postsSelectCount === 1) return mockPost ? [mockPost] : [];
          return mockOriginalPost ? [mockOriginalPost] : [];
        }
        return [];
      },
      then: (
        resolve: (value: unknown[]) => void,
        reject: (reason: unknown) => void
      ) =>
        Promise.resolve(
          table === postsTable ? (mockPost ? [mockPost] : []) : []
        ).then(resolve, reject),
    };
    return chain;
  },
  insert: (table: { __t: string }) => ({
    values: (..._args: unknown[]) => {
      if (table === reactionsTable) {
        likeInsertMock();
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: 'reaction-1' }],
          }),
        };
      }
      return Promise.resolve(undefined);
    },
  }),
  transaction: mock(async (callback: (tx: unknown) => Promise<void>) => {
    await callback({
      insert: (table: { __t: string }) => ({
        values: mock(async (..._args: unknown[]) => {
          if (table === sharesTable) shareInsertMock();
        }),
      }),
    });
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
  comments: { __t: 'comments' },
  db: mockDb,
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: { __t: 'follows' },
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
  reactions: reactionsTable,
  shares: sharesTable,
  sql: {},
  users: { __t: 'users' },
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

const { executeDirectLike, executeDirectRepost } = await import(
  '../DirectExecutors'
);

describe('executeDirectLike moderation', () => {
  beforeEach(() => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: 'hello world',
      originalPostId: null,
      deletedAt: null,
    };
    mockOriginalPost = null;
    postsSelectCount = 0;
    blockedPairs.clear();
    likeInsertMock.mockClear();
    shareInsertMock.mockClear();
  });

  test('rejects a like on a soft-deleted post', async () => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: 'hello world',
      originalPostId: null,
      deletedAt: new Date(),
    };

    const result = await executeDirectLike({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot like deleted post');
    expect(likeInsertMock).not.toHaveBeenCalled();
  });

  test('likes a live post', async () => {
    const result = await executeDirectLike({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(true);
    expect(result.liked).toBe(true);
    expect(likeInsertMock).toHaveBeenCalled();
  });
});

describe('executeDirectRepost moderation', () => {
  beforeEach(() => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: 'hello world',
      originalPostId: null,
      deletedAt: null,
    };
    mockOriginalPost = null;
    postsSelectCount = 0;
    blockedPairs.clear();
    likeInsertMock.mockClear();
    shareInsertMock.mockClear();
  });

  test('rejects a repost of a soft-deleted post', async () => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: 'hello world',
      originalPostId: null,
      deletedAt: new Date(),
    };

    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot share deleted post');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('rejects a repost when the post author blocked the agent', async () => {
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot share this post');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('rejects a repost when the agent blocked the post author', async () => {
    blockedPairs.add('agent-1:user-2');

    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot share this post');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('rejects a repost of a pure repost whose original is soft-deleted', async () => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: '',
      originalPostId: 'post-0',
      deletedAt: null,
    };
    mockOriginalPost = {
      id: 'post-0',
      authorId: 'user-9',
      content: 'Original content',
      originalPostId: null,
      deletedAt: new Date(),
    };

    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot share deleted post');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('rejects a repost of a pure repost whose original author blocked the agent', async () => {
    mockPost = {
      id: 'post-1',
      authorId: 'user-2',
      content: '',
      originalPostId: 'post-0',
      deletedAt: null,
    };
    mockOriginalPost = {
      id: 'post-0',
      authorId: 'user-9',
      content: 'Original content',
      originalPostId: null,
      deletedAt: null,
    };
    blockedPairs.add('user-9:agent-1');

    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot share this post');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('reposts a live post', async () => {
    const result = await executeDirectRepost({
      agentUserId: 'agent-1',
      postId: 'post-1',
    });

    expect(result.success).toBe(true);
    expect(result.repostId).toBe('snowflake-id');
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(shareInsertMock).toHaveBeenCalled();
  });
});
