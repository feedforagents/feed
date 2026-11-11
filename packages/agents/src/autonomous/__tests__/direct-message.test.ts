import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mutable canned rows for the mocked drizzle-style db. Each select() call
// branches on the table passed to from() and the keys of the select shape,
// mirroring how executeDirectMessage queries each table.
let mockAgentRow: { managedBy: string | null } | null = {
  managedBy: null,
};
let mockRecipient: { id: string; isActor: boolean } | null = {
  id: 'user-2',
  isActor: false,
};
let mockNpc: { id: string } | null = null;
let mockExistingChat: { chatId: string } | null = null;
let mockMembership: { chatId: string } | null = { chatId: 'chat-1' };
let mockDmChat: { isGroup: boolean } | null = { isGroup: false };
let mockParticipants: Array<{ userId: string }> = [
  { userId: 'agent-1' },
  { userId: 'user-2' },
];
let mockOtherUser: { isActor: boolean } | null = { isActor: false };

const blockedPairs = new Set<string>();

const transactionMock = mock(async (fn: (tx: unknown) => unknown) => {
  const tx = {
    insert: () => ({ values: mock(async () => undefined) }),
  };
  return fn(tx);
});
const messageInsertMock = mock(async () => undefined);

const usersTable = {
  __t: 'users',
  id: 'u.id',
  managedBy: 'u.managedBy',
  isActor: 'u.isActor',
  displayName: 'u.displayName',
};
const chatsTable = {
  __t: 'chats',
  id: 'c.id',
  isGroup: 'c.isGroup',
  name: 'c.name',
};
const chatParticipantsTable = {
  __t: 'chatParticipants',
  chatId: 'cp.chatId',
  userId: 'cp.userId',
  isActive: 'cp.isActive',
};
const actorStateTable = { __t: 'actorState', id: 'a.id' };

function resolveSelect(
  table: { __t: string } | null,
  shape: Record<string, unknown>,
  joined: boolean
): unknown[] {
  const keys = Object.keys(shape);
  if (table === usersTable) {
    if (keys.includes('managedBy')) return mockAgentRow ? [mockAgentRow] : [];
    // Recipient lookup: the original code selects only { id }, the fix
    // also selects isActor — either shape resolves to the recipient row.
    if (keys.includes('id')) return mockRecipient ? [mockRecipient] : [];
    if (keys.includes('isActor')) return mockOtherUser ? [mockOtherUser] : [];
    if (keys.includes('displayName')) return [{ displayName: 'Agent One' }];
    return [];
  }
  if (table === actorStateTable) return mockNpc ? [mockNpc] : [];
  if (table === chatParticipantsTable) {
    if (joined) return mockExistingChat ? [mockExistingChat] : [];
    if (keys.includes('chatId')) return mockMembership ? [mockMembership] : [];
    if (keys.includes('userId')) return mockParticipants;
    return [];
  }
  if (table === chatsTable) {
    if (keys.includes('isGroup')) return mockDmChat ? [mockDmChat] : [];
    if (keys.includes('name')) return [{ name: 'Test Group' }];
    return [];
  }
  return [];
}

const mockDb = {
  select: (shape: Record<string, unknown>) => {
    let table: { __t: string } | null = null;
    let joined = false;
    const chain: Record<string, unknown> = {
      from: (t: { __t: string }) => {
        table = t;
        return chain;
      },
      innerJoin: () => {
        joined = true;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: async () => resolveSelect(table, shape, joined),
      then: (
        resolve: (value: unknown[]) => void,
        reject: (reason: unknown) => void
      ) =>
        Promise.resolve(resolveSelect(table, shape, joined)).then(
          resolve,
          reject
        ),
    };
    return chain;
  },
  insert: mock(() => ({
    values: messageInsertMock,
  })),
  delete: mock(() => ({
    where: mock(() => ({
      returning: mock(async () => []),
    })),
  })),
  transaction: transactionMock,
};

mock.module('@feed/db', () => ({
  actorState: actorStateTable,
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: chatParticipantsTable,
  chats: chatsTable,
  comments: {},
  db: mockDb,
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: { id: 'id', followerId: 'followerId', followingId: 'followingId' },
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
  posts: {
    id: 'id',
    authorId: 'authorId',
    content: 'content',
    originalPostId: 'originalPostId',
  },
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

const { executeDirectMessage } = await import('../DirectExecutors');

describe('executeDirectMessage DM moderation', () => {
  beforeEach(() => {
    mockAgentRow = { managedBy: null };
    mockRecipient = { id: 'user-2', isActor: false };
    mockNpc = null;
    mockExistingChat = null;
    mockMembership = { chatId: 'chat-1' };
    mockDmChat = { isGroup: false };
    mockParticipants = [{ userId: 'agent-1' }, { userId: 'user-2' }];
    mockOtherUser = { isActor: false };
    blockedPairs.clear();
    transactionMock.mockClear();
    messageInsertMock.mockClear();
  });

  test('rejects a DM when the recipient has blocked the agent', async () => {
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot send messages to this user');
    // No DM chat is created and no message is stored.
    expect(transactionMock).not.toHaveBeenCalled();
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a DM when the agent has blocked the recipient', async () => {
    blockedPairs.add('agent-1:user-2');

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot send messages to this user');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a DM to an NPC recipient', async () => {
    mockRecipient = { id: 'npc-1', isActor: true };

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      recipientId: 'npc-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('NPC actors');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a DM to an actorState-only recipient', async () => {
    mockRecipient = null;
    mockNpc = { id: 'npc-1' };

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      recipientId: 'npc-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('NPC actors');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('sends a DM to an unblocked user and creates the chat', async () => {
    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      content: 'hello there',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('snowflake-id');
    expect(transactionMock).toHaveBeenCalled();
    expect(messageInsertMock).toHaveBeenCalled();
  });

  test('rejects a send into a DM chat by ID when the other side blocked the agent', async () => {
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      chatId: 'chat-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot send messages to this user');
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('rejects a send into a DM chat by ID when the other side is an NPC', async () => {
    mockOtherUser = { isActor: true };

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      chatId: 'chat-1',
      content: 'hello there',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('NPC actors');
    expect(messageInsertMock).not.toHaveBeenCalled();
  });

  test('allows a send into an unblocked DM chat by ID', async () => {
    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      chatId: 'chat-1',
      content: 'hello there',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('snowflake-id');
    expect(messageInsertMock).toHaveBeenCalled();
  });

  test('allows a send into a group chat by ID without a DM block check', async () => {
    mockDmChat = { isGroup: true };
    blockedPairs.add('user-2:agent-1');

    const result = await executeDirectMessage({
      agentUserId: 'agent-1',
      chatId: 'chat-1',
      content: 'hello there',
    });

    expect(result.success).toBe(true);
    expect(messageInsertMock).toHaveBeenCalled();
  });
});
