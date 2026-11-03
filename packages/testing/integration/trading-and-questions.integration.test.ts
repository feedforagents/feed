/**
 * Live question creation and NPC execution against a disposable local database.
 * NPC decisions can create social records and modify markets; discard the test
 * database after the suite rather than trying to reverse unpredictable actions.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  agentRuntimeManager,
  autonomousCoordinator,
  npcBootstrapService,
} from '@feed/agents';
import {
  actorState,
  agentTrades,
  and,
  chatParticipants,
  chats,
  comments,
  db,
  dmAcceptances,
  eq,
  follows,
  inArray,
  markets,
  messages,
  notifications,
  npcTrades,
  poolPositions,
  positions,
  posts,
  questionArcPlans,
  questions,
  reactions,
  shares,
  sql,
  trajectories,
  users,
} from '@feed/db';
import {
  FeedLLMClient,
  QuestionManager,
  StaticDataRegistry,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { getRecentPosts } from '../../agents/src/autonomous/utils/context-gatherers';
import { gatherPendingChatMessages } from '../../agents/src/autonomous/utils/interaction-gatherers';
import {
  getLLMCallCallback,
  setLLMCallCallback,
} from '../../engine/src/dag-trace/llm-interceptor';
import type { LLMCallInput } from '../../engine/src/dag-trace/types';
import {
  getOrCreateDMChat,
  sendMessageToChat,
} from '../../engine/src/services/dm-service';
import { GameBootstrapService } from '../../engine/src/services/game-bootstrap-service';
import { resolveLiveLlmTestConfig } from './helpers/live-runtime';

const live = resolveLiveLlmTestConfig();
const liveTest = test.skipIf(!live.enabled);
const npcId = 'ailon-musk';
const questionBudgetMs = 180_000; // The production game tick's default budget.
const maxNpcTicks = 3;
const testTimeoutMs = 900_000; // Up to three NPC ticks, each with real LLM calls.
let originalQuestionIds = new Set<string>();
let createdQuestionIds: string[] = [];
let createdActorState = false;
let runtimeStarted = false;
let fixtureUserId: string | undefined;
let fixturePostId: string | undefined;
let fixtureChatId: string | undefined;

function assertDisposableDatabaseUrl(value: string | undefined, label: string) {
  if (!value)
    throw new Error(`${label} is required for live integration tests`);
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !/(?:^|[_-])(test|testing|verification)(?:[_-]|$)/i.test(databaseName)
  ) {
    throw new Error(
      `${label} must point to a local test or verification database`
    );
  }
  return databaseName;
}

beforeAll(async () => {
  if (live.requested && !live.enabled) {
    throw new Error(live.skipReason ?? 'Live LLM test setup failed');
  }
  if (!live.enabled) return;

  const databaseName = assertDisposableDatabaseUrl(
    process.env.DATABASE_URL,
    'DATABASE_URL'
  );
  for (const label of [
    'DIRECT_DATABASE_URL',
    'DATABASE_READ_REPLICA_URL',
  ] as const) {
    if (
      process.env[label] &&
      assertDisposableDatabaseUrl(process.env[label], label) !== databaseName
    ) {
      throw new Error(`${label} must point to the same disposable database`);
    }
  }
  const [connected] = await db.execute(sql`SELECT current_database() AS name`);
  if (connected?.name !== databaseName)
    throw new Error('Connected database does not match DATABASE_URL');
  await GameBootstrapService.bootstrapIfNeeded();
  originalQuestionIds = new Set(
    (await db.select({ id: questions.id }).from(questions)).map((q) => q.id)
  );
});

afterAll(async () => {
  if (!live.enabled) return;
  if (runtimeStarted) await agentRuntimeManager.clearRuntime(npcId);
  if (fixtureChatId) {
    await db.delete(messages).where(eq(messages.chatId, fixtureChatId));
    await db
      .delete(dmAcceptances)
      .where(eq(dmAcceptances.chatId, fixtureChatId));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, fixtureChatId));
    await db.delete(chats).where(eq(chats.id, fixtureChatId));
  }
  if (fixturePostId) {
    await db.delete(reactions).where(eq(reactions.postId, fixturePostId));
    await db.delete(shares).where(eq(shares.postId, fixturePostId));
    await db.delete(comments).where(eq(comments.postId, fixturePostId));
    await db.delete(posts).where(eq(posts.id, fixturePostId));
  }
  if (fixtureUserId) {
    await db.delete(follows).where(eq(follows.followingId, fixtureUserId));
    await db
      .delete(notifications)
      .where(eq(notifications.userId, fixtureUserId));
    await db.delete(users).where(eq(users.id, fixtureUserId));
  }
  if (createdActorState) {
    // The actor may now have positions, messages, and other game state. Its
    // rows are retained for disposal with the isolated database.
    console.info(`Live NPC state retained in disposable database for ${npcId}`);
  }
  if (createdQuestionIds.length === 0) return;

  // Do not remove a market that has acquired trades or positions. Those records
  // and all unpredictable NPC side effects belong to the disposable database.
  const [predictionPositions, poolPositionRows, tradeRows, npcTradeRows] =
    await Promise.all([
      db
        .select({ id: positions.id })
        .from(positions)
        .where(inArray(positions.marketId, createdQuestionIds)),
      db
        .select({ id: poolPositions.id })
        .from(poolPositions)
        .where(inArray(poolPositions.marketId, createdQuestionIds)),
      db
        .select({ id: agentTrades.id })
        .from(agentTrades)
        .where(inArray(agentTrades.marketId, createdQuestionIds)),
      db
        .select({ id: npcTrades.id })
        .from(npcTrades)
        .where(inArray(npcTrades.marketId, createdQuestionIds)),
    ]);
  if (
    predictionPositions.length ||
    poolPositionRows.length ||
    tradeRows.length ||
    npcTradeRows.length
  ) {
    console.info(
      'Live questions and markets with trade history retained in disposable database'
    );
    return;
  }
  await db.delete(questions).where(inArray(questions.id, createdQuestionIds));
  await db.delete(markets).where(inArray(markets.id, createdQuestionIds));
});

describe('live question generation and NPC execution', () => {
  liveTest(
    'creates a real generated question, market, and arc',
    async () => {
      const previousCallback = getLLMCallCallback();
      const calls: LLMCallInput[] = [];
      setLLMCallCallback((call) => {
        calls.push(call);
        previousCallback?.(call);
      });
      let created = 0;
      try {
        const manager = new QuestionManager(FeedLLMClient.forGameTick());
        const deadline = Date.now() + questionBudgetMs;
        for (
          let attempt = 0;
          attempt < 3 && created === 0 && Date.now() < deadline;
          attempt++
        ) {
          created += await manager.generateQuestionsForContinuousGame(
            1,
            deadline
          );
        }
      } finally {
        setLLMCallCallback(previousCallback);
        createdQuestionIds = (
          await db.select({ id: questions.id }).from(questions)
        )
          .map((row) => row.id)
          .filter((id) => !originalQuestionIds.has(id));
      }

      expect(
        calls.some(
          (call) =>
            call.promptType === 'question_generate_real_world' && call.success
        )
      ).toBe(true);
      expect(
        calls.some((call) => call.promptType === 'npc-market-decisions')
      ).toBe(false);
      expect(created).toBeGreaterThan(0);
      expect(createdQuestionIds).toHaveLength(created);
      for (const questionId of createdQuestionIds) {
        const [question] = await db
          .select()
          .from(questions)
          .where(eq(questions.id, questionId));
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.id, questionId));
        const arcs = await db
          .select()
          .from(questionArcPlans)
          .where(eq(questionArcPlans.questionId, questionId));
        expect(question).toBeDefined();
        expect(market).toBeDefined();
        expect(question?.status).toBe('active');
        expect(question?.text).not.toMatch(/^\s*(?:In\s+)?How many\b/i);
        expect(market?.question).toBe(question?.text);
        expect(market?.resolved).toBe(false);
        expect(Number(market?.liquidity)).toBeGreaterThan(0);
        expect(market?.endDate.getTime()).toBe(
          question?.resolutionDate.getTime()
        );
        expect(arcs).toHaveLength(1);
      }
      console.info(
        `Live question generation created ${created} question(s) with markets and arcs`
      );
    },
    testTimeoutMs
  );

  liveTest(
    'executes a canonical NPC with real decisions and accounts for actions',
    async () => {
      expect(createdQuestionIds.length).toBeGreaterThan(0);
      const actor = StaticDataRegistry.getActor(npcId);
      if (!actor || actor.id !== npcId)
        throw new Error(`Canonical NPC not found: ${npcId}`);
      const [existingActor] = await db
        .select()
        .from(actorState)
        .where(eq(actorState.id, npcId));
      if (!existingActor) {
        await db.insert(actorState).values({
          id: npcId,
          tradingBalance: '10000',
          updatedAt: new Date(),
        });
        createdActorState = true;
      }
      const [beforeActor] = await db
        .select()
        .from(actorState)
        .where(eq(actorState.id, npcId));
      if (!beforeActor || Number(beforeActor.tradingBalance) < 100) {
        throw new Error(
          'The live test NPC requires at least 100 points of trading balance'
        );
      }
      const beforeTradeIds = new Set(
        (
          await db
            .select({ id: agentTrades.id })
            .from(agentTrades)
            .where(eq(agentTrades.agentUserId, npcId))
        ).map((row) => row.id)
      );
      runtimeStarted = true;
      await npcBootstrapService.bootstrapNpc(npcId);
      const runtime = await agentRuntimeManager.getRuntime(npcId);
      const [generatedQuestion] = await db
        .select({ text: questions.text })
        .from(questions)
        .where(eq(questions.id, createdQuestionIds[0]!));
      if (!generatedQuestion) throw new Error('Generated question is missing');
      fixtureUserId = await generateSnowflakeId();
      fixturePostId = await generateSnowflakeId();
      await db.insert(users).values({
        id: fixtureUserId,
        username: `observer_${fixtureUserId.slice(-12)}`,
        displayName: 'Launch Observer',
        updatedAt: new Date(),
      });
      await db.insert(posts).values({
        id: fixturePostId,
        authorId: fixtureUserId,
        content: `Watching this question: ${generatedQuestion.text} I am waiting for public evidence before deciding. What would you look for?`,
        timestamp: new Date(),
        createdAt: new Date(),
      });
      fixtureChatId = await getOrCreateDMChat(fixtureUserId, npcId);
      await sendMessageToChat(
        fixtureChatId,
        fixtureUserId,
        `Hi AIlon, I saw this market: ${generatedQuestion.text} What evidence would you watch before deciding? I would appreciate your take.`
      );
      expect(
        (await getRecentPosts(npcId)).some((post) => post.id === fixturePostId)
      ).toBe(true);
      expect(
        (await gatherPendingChatMessages(npcId)).some(
          (message) => message.chatId === fixtureChatId
        )
      ).toBe(true);
      let successfulActions = 0;
      let reportedTrades = 0;
      for (let tick = 0; tick < maxNpcTicks && reportedTrades === 0; tick++) {
        const result = await autonomousCoordinator.executeAutonomousTick(
          npcId,
          runtime,
          true,
          true
        );
        expect(result.success).toBe(true);
        expect(result.method).toBe('multi_step');
        expect(result.trajectoryId).toBeDefined();
        const [trajectory] = await db
          .select()
          .from(trajectories)
          .where(eq(trajectories.trajectoryId, result.trajectoryId!));
        expect(trajectory?.agentId).toBe(npcId);
        expect(trajectory?.episodeLength).toBeGreaterThan(0);
        successfulActions += Object.values(result.actionsExecuted).reduce(
          (sum, value) => sum + value,
          0
        );
        reportedTrades += result.actionsExecuted.trades;
      }
      expect(successfulActions).toBeGreaterThan(0);

      const recordedTrades = (
        await db
          .select()
          .from(agentTrades)
          .where(eq(agentTrades.agentUserId, npcId))
      ).filter((trade) => !beforeTradeIds.has(trade.id));
      const [afterActor] = await db
        .select()
        .from(actorState)
        .where(eq(actorState.id, npcId));
      expect(afterActor).toBeDefined();
      expect(Number.isFinite(Number(afterActor?.tradingBalance))).toBe(true);
      expect(Number(afterActor?.tradingBalance)).toBeGreaterThanOrEqual(0);
      if (reportedTrades > 0) {
        expect(recordedTrades.length).toBeGreaterThanOrEqual(reportedTrades);
        expect(Number(afterActor?.tradingBalance)).not.toBe(
          Number(beforeActor.tradingBalance)
        );
        for (const trade of recordedTrades) {
          if (trade.marketType === 'prediction') {
            expect(trade.marketId).toBeTruthy();
            const related = await db
              .select()
              .from(positions)
              .where(
                and(
                  eq(positions.userId, npcId),
                  eq(positions.marketId, trade.marketId!)
                )
              );
            expect(related.length).toBeGreaterThan(0);
          } else if (trade.marketType === 'perp') {
            expect(trade.ticker).toBeTruthy();
            const related = await db
              .select()
              .from(poolPositions)
              .where(
                and(
                  eq(poolPositions.poolId, npcId),
                  eq(poolPositions.ticker, trade.ticker!)
                )
              );
            expect(related.length).toBeGreaterThan(0);
          } else {
            throw new Error(
              `Unexpected recorded NPC trade type: ${trade.marketType}`
            );
          }
        }
      } else {
        expect(recordedTrades).toHaveLength(0);
        console.info(
          'NPC completed real actions but did not choose a trade; no model-selected trade is claimed'
        );
      }
      console.info(
        `NPC executed ${successfulActions} action(s), including ${reportedTrades} trade(s)`
      );
    },
    testTimeoutMs
  );
});
