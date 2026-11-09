import { afterAll, expect, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import {
  chatParticipants,
  chats,
  db,
  eq,
  groups,
  markets,
  messages,
  notifications,
  organizationState,
  perpPositions,
  positions,
  tags,
  trendingTags,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import { resolveGroupChatByName } from '../../agents/src/autonomous/utils/context-gatherers';
import {
  chatsContextSchema,
  organizationMentionsContextSchema,
  perpetualMarketsContextSchema,
  predictionMarketsContextSchema,
  trendingContextSchema,
  userMentionsContextSchema,
} from '../../agents/src/plugins/feed/providers/context-contracts';
import { recentMessagesProvider } from '../../agents/src/plugins/plugin-agent-core/src/providers/recent-messages';

const userId = `portfolio-audit-${crypto.randomUUID()}`;
// Organization state rows this suite inserted (CI starts from an empty schema).
const createdOrgStateIds: string[] = [];
const createdVisibleAgentIds: string[] = [];
afterAll(async () => {
  for (const id of createdVisibleAgentIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdOrgStateIds) {
    await db.delete(organizationState).where(eq(organizationState.id, id));
  }
  await db.delete(trendingTags).where(eq(trendingTags.id, userId));
  await db.delete(tags).where(eq(tags.id, userId));
  await db.delete(messages).where(eq(messages.senderId, userId));
  await db.delete(chatParticipants).where(eq(chatParticipants.userId, userId));
  await db.delete(chats).where(eq(chats.createdBy, userId));
  await db.delete(groups).where(eq(groups.ownerId, userId));
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await db.delete(positions).where(eq(positions.userId, userId));
  await db.delete(markets).where(eq(markets.id, userId));
  await db.delete(users).where(eq(users.id, userId));
});

test('A2A rejects nonexistent portfolio owners instead of returning zero/empty', async () => {
  for (const operation of [
    'portfolio.get_balance',
    'portfolio.get_positions',
  ]) {
    await expect(
      FeedAgentExecutor.executeDirectly(operation, {}, `${userId}-missing`)
    ).rejects.toThrow('does not exist');
  }
});

test('A2A returns persisted balance and fails on missing position price sources', async () => {
  await db.insert(users).values({
    id: userId,
    username: userId,
    isAgent: true,
    isTest: true,
    virtualBalance: '1234.56',
    updatedAt: new Date(),
  });
  const balance = await FeedAgentExecutor.executeDirectly(
    'portfolio.get_balance',
    {},
    userId
  );
  expect(balance).toMatchObject({ balance: 1234.56 });
  expect(
    await FeedAgentExecutor.executeDirectly(
      'portfolio.get_positions',
      {},
      userId
    )
  ).toMatchObject({ marketPositions: [], perpPositions: [] });
  await db.insert(markets).values({
    id: userId,
    question: 'Preserve YES side?',
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    updatedAt: new Date(),
  });
  await db.insert(positions).values({
    id: `${userId}-yes`,
    userId,
    marketId: userId,
    side: true,
    outcome: null,
    shares: '10',
    avgPrice: '0.5',
    updatedAt: new Date(),
  });
  expect(
    await FeedAgentExecutor.executeDirectly(
      'portfolio.get_positions',
      {},
      userId
    )
  ).toMatchObject({ marketPositions: [{ side: 'YES', shares: 10 }] });
  await db.insert(perpPositions).values({
    id: `${userId}-perp`,
    userId,
    ticker: 'AUDIT',
    organizationId: `${userId}-missing`,
    side: 'long',
    entryPrice: 10,
    currentPrice: 12,
    size: 100,
    leverage: 1,
    liquidationPrice: 0,
    unrealizedPnL: 20,
    unrealizedPnLPercent: 20,
    lastUpdated: new Date(),
  });
  await expect(
    FeedAgentExecutor.executeDirectly('portfolio.get_positions', {}, userId)
  ).rejects.toThrow('missing organization');
});

test('A2A rejects conflicting account targets rather than relabeling the caller wallet', async () => {
  for (const operation of [
    'portfolio.get_balance',
    'portfolio.get_positions',
    'portfolio.get_user_wallet',
  ]) {
    await expect(
      FeedAgentExecutor.executeDirectly(
        operation,
        { userId: 'a-different-account' },
        userId
      )
    ).rejects.toThrow('Account target does not match');
  }
});

test('A2A rejects a nonexistent profile rather than inventing a zero-balance user', async () => {
  await expect(
    FeedAgentExecutor.executeDirectly(
      'users.get_profile',
      { userId: `${userId}-missing-profile` },
      userId
    )
  ).rejects.toThrow('does not exist');
});

test('A2A market responses satisfy the prompt provider contracts', async () => {
  const predictions = predictionMarketsContextSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'markets.list_prediction',
      { status: 'active' },
      userId
    )
  );
  expect(predictions.predictions.length).toBeGreaterThan(0);
  const perpetuals = perpetualMarketsContextSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'markets.list_perpetuals',
      {},
      userId
    )
  );
  expect(Array.isArray(perpetuals.perpetuals)).toBe(true);
});

test('organization context resolves real names and tickers; user context retains agent identity', async () => {
  // The portfolio owner is deliberately a hidden test account. Use a separate
  // owned non-test agent to exercise the positive mention-identity contract.
  const visibleAgentId = `${userId}-visible-agent`;
  const insertedAgents = await db
    .insert(users)
    .values({
      id: visibleAgentId,
      username: visibleAgentId,
      isAgent: true,
      isTest: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  createdVisibleAgentIds.push(...insertedAgents.map((row) => row.id));
  const [staticOrg] = StaticDataRegistry.getAllOrganizations();
  if (!staticOrg) throw new Error('Static data registry has no organizations');
  const inserted = await db
    .insert(organizationState)
    .values({ id: staticOrg.id, currentPrice: 100, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: organizationState.id });
  createdOrgStateIds.push(...inserted.map((row) => row.id));
  const { organizations } = organizationMentionsContextSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'stats.get_organizations',
      { limit: 100 },
      userId
    )
  );
  expect(organizations.length).toBeGreaterThan(0);
  expect(organizations.every((org) => org.name !== org.id)).toBe(true);
  const { users: found } = userMentionsContextSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'users.search',
      { query: userId },
      userId
    )
  );
  expect(found.find((user) => user.id === visibleAgentId)?.isAgent).toBe(true);
  expect(found.some((user) => user.id === userId)).toBe(false);
});

test('notifications include actual unread totals independently of the page limit', async () => {
  await db.insert(notifications).values([
    {
      id: `${userId}-n1`,
      userId,
      type: 'chat_message',
      title: 'Chat',
      message: 'One',
      read: false,
      chatId: userId,
    },
    {
      id: `${userId}-n2`,
      userId,
      type: 'system',
      title: 'System',
      message: 'Two',
      read: false,
    },
  ]);
  expect(
    await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 1 },
      userId
    )
  ).toMatchObject({ unreadCount: 2 });
  expect(
    await FeedAgentExecutor.executeDirectly(
      'messaging.get_unread_count',
      {},
      userId
    )
  ).toEqual({ unreadCount: 1 });
});

test('named message destinations require exact, active, unambiguous group membership', async () => {
  for (const [suffix, name, isActive] of [
    ['one', 'Alerts_%', true],
    ['inactive', 'Inactive', false],
    ['archive', 'Alerts_% Archive', true],
  ] as const) {
    const id = `${userId}-${suffix}`;
    await db.insert(groups).values({
      id,
      name,
      type: 'user',
      ownerId: userId,
      createdById: userId,
      updatedAt: new Date(),
    });
    await db.insert(chats).values({
      id,
      groupId: id,
      name,
      isGroup: true,
      createdBy: userId,
      updatedAt: new Date(),
    });
    await db
      .insert(chatParticipants)
      .values({ id, userId, chatId: id, isActive });
  }
  expect(await resolveGroupChatByName(userId, 'Alerts_%')).toBe(
    `${userId}-one`
  );
  expect(await resolveGroupChatByName(userId, 'Alerts')).toBeNull();
  expect(await resolveGroupChatByName(userId, 'Inactive')).toBeNull();
  await db
    .update(groups)
    .set({ name: 'Alerts_%' })
    .where(eq(groups.id, `${userId}-archive`));
  await expect(resolveGroupChatByName(userId, 'Alerts_%')).rejects.toThrow(
    'Ambiguous group name'
  );
});

test('reply context includes the unpersisted current message with and without stored history', async () => {
  const chatId = `${userId}-one`;
  await db.insert(messages).values({
    id: `${userId}-history`,
    chatId,
    senderId: userId,
    content: 'Earlier code phrase: circuit-amber-47',
    targetIds: [userId],
  });
  const currentText = 'What was the phrase, and what is my available balance?';
  for (const room of [chatId, `${userId}-archive`]) {
    const context = await recentMessagesProvider.get(
      { agentId: userId } as IAgentRuntime,
      {
        entityId: userId,
        roomId: room,
        agentId: userId,
        content: {
          text: currentText,
          teamChatId: room,
          ownerId: userId,
          agentId: userId,
        },
      } as Memory,
      { values: {}, text: '', data: {} } as State
    );
    expect(context.text).toContain(currentText);
    expect(context.values?.recentMessages).toContain(currentText);
    if (room === chatId) expect(context.text).toContain('circuit-amber-47');
  }
});

test('chat context returns active participants instead of fabricating zero', async () => {
  const result = chatsContextSchema.parse(
    await FeedAgentExecutor.executeDirectly('messaging.get_chats', {}, userId)
  );
  expect(result.chats.length).toBe(2);
  for (const chat of result.chats)
    expect(chat.participants).toEqual([{ id: userId }]);
  expect(() =>
    chatsContextSchema.parse({
      chats: [{ id: 'missing-members', name: null, isGroup: false }],
    })
  ).toThrow();
});

test('trending context preserves real tag identity and rejects orphaned tags', async () => {
  const now = new Date();
  await db.insert(tags).values({
    id: userId,
    name: userId,
    displayName: 'Audit Tag',
    category: null,
    updatedAt: now,
  });
  await db.insert(trendingTags).values({
    id: userId,
    tagId: userId,
    score: 1000000000,
    postCount: 0,
    rank: 1,
    windowStart: now,
    windowEnd: now,
  });
  const result = trendingContextSchema.parse(
    await FeedAgentExecutor.executeDirectly(
      'stats.trending_tags',
      { limit: 1 },
      userId
    )
  );
  expect(result.tags).toEqual([
    {
      id: userId,
      name: userId,
      displayName: 'Audit Tag',
      category: null,
      postCount: 0,
      score: 1000000000,
    },
  ]);
  await db.delete(tags).where(eq(tags.id, userId));
  await expect(
    FeedAgentExecutor.executeDirectly(
      'stats.trending_tags',
      { limit: 1 },
      userId
    )
  ).rejects.toThrow('missing its required identity');
  expect(() =>
    trendingContextSchema.parse({ tags: [{ name: 'lost-id' }] })
  ).toThrow();
});
