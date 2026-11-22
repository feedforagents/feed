import { expect, test } from 'bun:test';
import { executeDirectPost } from '@feed/agents';
import {
  dbWrite,
  eq,
  games,
  inArray,
  markets,
  npcMarketClues,
  posts,
  questionArcPlans,
  questions,
  timeframedMarketRoles,
  timeframedMarkets,
} from '@feed/db';
import { isActiveHour, StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import {
  getNpcMarketCluePublication,
  publishNpcMarketClue,
  selectDueNpcMarketClue,
} from '../../agents/src/autonomous/npc-market-clue';
import { getNpcGameContext } from '../../agents/src/plugins/feed/providers/npc-game-context';
import { getTimedNpcRoleContext } from '../../agents/src/plugins/feed/providers/npc-timed-market-signals';

test('publishes one current clue per market phase and preserves ordinary NPC posts', async () => {
  const now = new Date();
  const actor = StaticDataRegistry.getAllActors().find((npc) =>
    isActiveHour(npc, now.getUTCHours())
  );
  if (!actor) throw new Error('No active NPC available for the clue fixture');

  const gameId = await generateSnowflakeId();
  const questionId = await generateSnowflakeId();
  const frameId = await generateSnowflakeId();
  const postIds = [await generateSnowflakeId(), await generateSnowflakeId()];
  const questionNumber = -Math.floor(Math.random() * 1_000_000_000);
  const future = new Date(now.getTime() + 15 * 60_000);
  const question = 'Will a lighthouse resume its nightly beacon scan?';
  const deploymentEnv = process.env.DEPLOYMENT_ENV;
  const gameStart = process.env.GAME_START;
  process.env.DEPLOYMENT_ENV = 'localnet';
  process.env.GAME_START = 'true';

  try {
    await dbWrite.transaction(async (tx) => {
      await tx
        .insert(games)
        .values({ id: gameId, isRunning: true, updatedAt: now });
      await tx.insert(markets).values({
        id: questionId,
        gameId,
        question,
        liquidity: '100',
        endDate: future,
        updatedAt: now,
      });
      await tx.insert(questions).values({
        id: questionId,
        questionNumber,
        marketId: questionId,
        text: question,
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: future,
        updatedAt: now,
      });
      await tx.insert(timeframedMarkets).values({
        id: frameId,
        questionId,
        timeframe: 'flash',
        startTime: now,
        endTime: future,
        arcState: 'live',
        arcStateEnteredAt: now,
        affiliatedActorIds: [actor.id],
      });
    });

    const initial = await selectDueNpcMarketClue(gameId, [actor.id]);
    if (!initial) throw new Error('Expected an eligible live clue');
    expect(initial.phase).toBe('live');
    expect(initial.oldestPendingAt).toEqual(now);
    expect(await getNpcMarketCluePublication(initial)).toBeUndefined();

    const candidatePost = (index: number) => ({
      id: postIds[index]!,
      authorId: actor.id,
      content: 'Watch for a full sweep of the harbor before sunset.',
    });
    await dbWrite
      .update(games)
      .set({ isRunning: false })
      .where(eq(games.id, gameId));
    expect(await publishNpcMarketClue(initial, candidatePost(0))).toBe('stale');
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();
    await dbWrite
      .update(games)
      .set({ isRunning: true })
      .where(eq(games.id, gameId));
    // The flash market is between its midpoint and close, but its persisted
    // phase has not advanced. Reject the old clue even while the market trades.
    await dbWrite
      .update(timeframedMarkets)
      .set({ startTime: new Date(now.getTime() - 20 * 60_000) })
      .where(eq(timeframedMarkets.id, frameId));
    expect(await publishNpcMarketClue(initial, candidatePost(0))).toBe('stale');
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();

    await dbWrite
      .update(timeframedMarkets)
      .set({ arcState: 'resolving' })
      .where(eq(timeframedMarkets.id, frameId));
    expect(await publishNpcMarketClue(initial, candidatePost(0))).toBe('stale');

    // Some short arcs have affiliates only. Persisted roles also qualify
    // their assigned actors, without exposing any role in the clue prompt.
    await dbWrite
      .update(timeframedMarkets)
      .set({ affiliatedActorIds: [] })
      .where(eq(timeframedMarkets.id, frameId));
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();
    await dbWrite.insert(questionArcPlans).values({
      id: await generateSnowflakeId(),
      questionId,
      uncertaintyPeakDay: 1,
      clarityOnsetDay: 1,
      verificationDay: 1,
      insiderActorIds: [actor.id],
      phaseRatios: { early: 0.5, middle: 0.5, late: 0.75, climax: 1 },
    });

    // Existing daily plans remain eligible while no timed role row exists.
    expect((await selectDueNpcMarketClue(gameId, [actor.id]))?.actorId).toBe(
      actor.id
    );
    expect(await getNpcGameContext(actor.id)).toContain(
      `You expect the following claim to come true: "${question}".`
    );
    await dbWrite.insert(timeframedMarketRoles).values({
      timeframedMarketId: frameId,
      insiderActorIds: [],
      deceiverActorIds: [],
    });
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();
    expect(await getNpcGameContext(actor.id)).not.toContain(question);

    // A timed-role-only NPC qualifies even when the frame has no affiliates,
    // and the timed deceiver signal supersedes the legacy insider role.
    await dbWrite
      .update(timeframedMarketRoles)
      .set({ deceiverActorIds: [actor.id] })
      .where(eq(timeframedMarketRoles.timeframedMarketId, frameId));
    expect(await getNpcGameContext(actor.id)).toContain(
      `You expect the following claim to not come true: "${question}".`
    );
    expect(await getNpcGameContext(actor.id, true)).not.toContain(question);

    const current = await selectDueNpcMarketClue(gameId, [actor.id]);
    if (!current) throw new Error('Expected an eligible resolving clue');
    expect(current.phase).toBe('resolving');
    expect(current.actorId).toBe(actor.id);
    await dbWrite
      .update(timeframedMarketRoles)
      .set({ deceiverActorIds: [] })
      .where(eq(timeframedMarketRoles.timeframedMarketId, frameId));
    expect(await publishNpcMarketClue(current, candidatePost(0))).toBe('stale');
    await dbWrite
      .update(timeframedMarketRoles)
      .set({ deceiverActorIds: [actor.id] })
      .where(eq(timeframedMarketRoles.timeframedMarketId, frameId));
    await dbWrite
      .update(timeframedMarkets)
      .set({ endTime: now })
      .where(eq(timeframedMarkets.id, frameId));
    expect(await getNpcGameContext(actor.id)).not.toContain(question);
    expect(await publishNpcMarketClue(current, candidatePost(0))).toBe('stale');
    await dbWrite
      .update(timeframedMarkets)
      .set({ endTime: future })
      .where(eq(timeframedMarkets.id, frameId));

    const attempts = await Promise.all([
      publishNpcMarketClue(current, candidatePost(0)),
      publishNpcMarketClue(current, candidatePost(1)),
    ]);
    expect(attempts.sort()).toEqual(['duplicate', 'published']);
    const linkedPosts = await dbWrite
      .select()
      .from(posts)
      .where(inArray(posts.id, postIds));
    expect(linkedPosts).toHaveLength(1);
    const [linkedPost] = linkedPosts;
    if (!linkedPost) throw new Error('Linked clue post missing');
    expect(linkedPost.relatedQuestion).toBe(questionNumber);
    expect(await getNpcMarketCluePublication(current)).toEqual({
      postId: linkedPost.id,
      publishedAt: linkedPost.timestamp,
    });
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();

    process.env.DEPLOYMENT_ENV = 'staging';
    const hosted = await getTimedNpcRoleContext(actor.id, [questionId]);
    expect(hosted.signals).toHaveLength(0);
    expect(hosted.timedQuestionIds.size).toBe(0);
    expect(await selectDueNpcMarketClue(gameId, [actor.id])).toBeUndefined();
    expect(await publishNpcMarketClue(current, candidatePost(0))).toBe('stale');
    const ordinary = await executeDirectPost({
      agentUserId: actor.id,
      content: 'Baking cinnamon rolls for the neighborhood potluck tonight.',
    });
    if (!ordinary.postId)
      throw new Error(ordinary.error || 'Ordinary post missing');
    postIds.push(ordinary.postId);
    const [ordinaryPost] = await dbWrite
      .select()
      .from(posts)
      .where(eq(posts.id, ordinary.postId));
    expect(ordinaryPost?.relatedQuestion).toBeNull();
  } finally {
    if (deploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = deploymentEnv;
    if (gameStart === undefined) delete process.env.GAME_START;
    else process.env.GAME_START = gameStart;
    await dbWrite.delete(posts).where(inArray(posts.id, postIds));
    await dbWrite
      .delete(npcMarketClues)
      .where(eq(npcMarketClues.questionId, questionId));
    await dbWrite
      .delete(timeframedMarkets)
      .where(eq(timeframedMarkets.id, frameId));
    await dbWrite.delete(questions).where(eq(questions.id, questionId));
    await dbWrite.delete(markets).where(eq(markets.id, questionId));
    await dbWrite.delete(games).where(eq(games.id, gameId));
  }
});
