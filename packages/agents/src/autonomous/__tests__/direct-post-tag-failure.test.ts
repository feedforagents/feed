import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * REPRO (candidate): executeDirectPost inserts the post row, then awaits
 * LLM tag generation (generateTagsFromPost) and storeTagsForPost with no
 * error guard. generateTagsFromPost throws on empty LLM content, malformed
 * XML, or any network/timeout failure of the Groq/OpenAI call, and
 * storeTagsForPost does real DB writes that can also fail. The post is
 * already committed at that point, but the throw propagates out of
 * executeDirectPost -> MultiStepExecutor.executePost -> executeAction,
 * which has no try/catch, so the whole tick aborts as failed and the
 * committed post is never recorded in the trace. The one-POST-per-tick
 * guard only counts successful trace entries, so the next tick can post
 * the same content again (duplicate post).
 *
 * The sibling plugin action (plugin-agent-core create-post) already
 * treats tagging as best-effort fire-and-forget ("don't block the
 * response"), and DirectExecutors' own broadcast calls are .catch-guarded.
 * executeDirectPost is the inconsistent one.
 *
 * Expected after fix: executeDirectPost resolves { success: true, postId }
 * even when tag generation throws; the tagging failure is only logged.
 */

let insertedPosts: Array<Record<string, unknown>> = [];
let tagGenerationError: Error | null = new Error(
  'Tag generation returned malformed XML'
);
let tagsToReturn: Array<{ name: string; displayName: string }> = [];
const storeTagsMock = mock(async () => undefined);

const mockDb = {
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () => [{ displayName: 'Test Agent' }]),
      })),
    })),
  })),
  insert: mock(() => ({
    values: mock((row: Record<string, unknown>) => {
      insertedPosts.push(row);
      return Promise.resolve();
    }),
  })),
};

mock.module('@feed/db', () => ({
  actorState: {},
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: {},
  chats: {},
  comments: {},
  db: mockDb,
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: {},
  groupMembers: {},
  groups: {},
  gte: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: {
    id: 'id',
    authorId: 'authorId',
    content: 'content',
    originalPostId: 'originalPostId',
    timestamp: 'timestamp',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
    commentOnPostId: 'commentOnPostId',
  },
  reactions: {},
  shares: {},
  sql: {},
  users: { id: 'id', isActor: 'isActor', displayName: 'displayName' },
}));

mock.module('@feed/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: { invalidateUserCache: mock(async () => undefined) },
  notifyGroupChatMessage: mock(async () => undefined),
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
  createNpcWalletAdapter: mock(() => ({})),
  createPerpPriceImpactPort: mock(() => ({})),
  createPerpSettlement: mock(() => ({})),
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: {},
  },
  FeeService: { processTradingFee: mock(async () => ({ feeCharged: 0 })) },
  generateTagsFromPost: mock(async () => {
    if (tagGenerationError) throw tagGenerationError;
    return tagsToReturn;
  }),
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {},
  StaticDataRegistry: {
    getActor: mock(() => null),
    getAllActors: mock(() => []),
    getAllOrganizations: mock(() => []),
  },
  storeTagsForPost: storeTagsMock,
  WalletService: class {},
  withPredictionSettlement: mock(async () => ({})),
}));

mock.module('@feed/shared', () => ({
  floorPoints: (n: number) => Math.floor(n),
  isPureRepost: mock(() => false),
}));

mock.module('../services/AgentPnLService', () => ({
  agentPnLService: { recordTrade: mock(async () => undefined) },
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
  generateSnowflakeId: mock(async () => 'snowflake-post-id'),
}));

mock.module('../TopicDiversityService', () => ({
  topicDiversityService: {
    validateContent: mock(() => []),
    recordTopicCoverage: mock(() => undefined),
    calculateSimilarity: mock(() => 0),
    trackPostTopics: mock(async () => undefined),
  },
}));

mock.module('../utils/resolvePerpTicker', () => ({
  resolvePerpTicker: mock(() => null),
}));

const { executeDirectPost } = await import('../DirectExecutors');

describe('executeDirectPost tag-generation failure', () => {
  beforeEach(() => {
    insertedPosts = [];
    tagGenerationError = new Error('Tag generation returned malformed XML');
    tagsToReturn = [];
    storeTagsMock.mockClear();
    storeTagsMock.mockImplementation(async () => undefined);
  });

  test('still reports success when LLM tag generation throws after the post is committed', async () => {
    const result = await executeDirectPost({
      agentUserId: 'agent-1',
      content: 'Sam AIltman announced SMH-6 at DevDay today',
    });

    expect(insertedPosts.length).toBe(1);
    expect(insertedPosts[0]?.content).toBe(
      'Sam AIltman announced SMH-6 at DevDay today'
    );
    expect(result.success).toBe(true);
    expect(result.postId).toBe('snowflake-post-id');
  });

  test('still reports success when tag storage throws after the post is committed', async () => {
    tagGenerationError = null;
    tagsToReturn = [{ name: 'teslai', displayName: 'TeslAI' }];
    storeTagsMock.mockImplementationOnce(async () => {
      throw new Error('tag store unavailable');
    });
    const result = await executeDirectPost({
      agentUserId: 'agent-1',
      content: 'TeslAI stock jumps after the earnings call',
    });

    expect(insertedPosts.length).toBe(1);
    expect(storeTagsMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.postId).toBe('snowflake-post-id');
  });
});
