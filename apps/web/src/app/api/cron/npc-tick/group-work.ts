import {
  DistributedLockService,
  recordCronExecution,
  successResponse,
} from '@feed/api';
import { dbWrite, eq, games } from '@feed/db';
import {
  FeedLLMClient,
  NPCGroupDynamicsService,
  RelationshipEvolutionEngine,
} from '@feed/engine';

const JOB = 'npc-group-work';
const WORK_BUDGET_MS = 80_000;
const LEASE_MS = 120_000;

export async function runNpcGroupWork(request: Request) {
  const start = new Date();
  const gameStart = process.env.GAME_START?.toLowerCase();
  if (
    gameStart === 'pause' ||
    gameStart === 'false' ||
    gameStart === '0' ||
    process.env.FEED_TRUST_CORPUS_FAST_MODE === 'true'
  ) {
    return successResponse({ success: true, skipped: true });
  }

  const owner = crypto.randomUUID();
  const acquired = await DistributedLockService.acquireLock({
    lockId: JOB,
    durationMs: LEASE_MS,
    operation: JOB,
    processId: owner,
  });
  if (!acquired) {
    return successResponse({ success: true, skipped: true });
  }

  try {
    const [game] = await dbWrite
      .select({ isRunning: games.isRunning })
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);
    if (!game?.isRunning) {
      return successResponse({ success: true, skipped: true });
    }

    const suppliedTime = Number(request.headers.get('x-cloudflare-cron-time'));
    const scheduledTime =
      suppliedTime > 0 && suppliedTime <= start.getTime()
        ? suppliedTime
        : start.getTime();
    const signal = AbortSignal.timeout(WORK_BUDGET_MS);
    const relationshipsDue = Math.floor(scheduledTime / 60_000) % 10 === 0;
    const [groups, relationships] = await Promise.allSettled([
      process.env.FEED_SKIP_NPC_GROUP_DYNAMICS === 'true'
        ? undefined
        : NPCGroupDynamicsService.processTickDynamics(Math.random, signal),
      relationshipsDue
        ? new RelationshipEvolutionEngine(
            FeedLLMClient.forGameTick()
          ).analyzeAndUpdateRelationships(signal)
        : 0,
    ]);

    if (relationshipsDue) {
      recordCronExecution('npc-relationship-evolution', start, {
        success: relationships.status === 'fulfilled',
        ...(relationships.status === 'fulfilled'
          ? { relationshipsUpdated: relationships.value }
          : { error: String(relationships.reason) }),
      });
    }
    recordCronExecution(JOB, start, {
      success: groups.status === 'fulfilled',
      ...(groups.status === 'fulfilled'
        ? groups.value
        : { error: String(groups.reason) }),
    });
    if (groups.status === 'rejected') throw groups.reason;

    return successResponse({
      success: true,
      dynamics: groups.value,
      relationshipsUpdated:
        relationships.status === 'fulfilled' ? relationships.value : 0,
    });
  } finally {
    await DistributedLockService.releaseLock(JOB, owner);
  }
}
