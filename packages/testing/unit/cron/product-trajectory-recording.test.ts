import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const fixtureNpc = { id: 'recording-npc', name: 'Recording Character' };
const game = {
  id: 'recording-game',
  isContinuous: true,
  isRunning: true,
  currentDay: 1,
};
const executeTick = mock(
  async (_id: string, _runtime: object, _record: boolean, _isNpc: boolean) => ({
    success: true,
    method: 'multi_step',
    duration: 1,
    actionsExecuted: {
      trades: 0,
      posts: 1,
      comments: 0,
      messages: 0,
      groupMessages: 0,
      engagements: 0,
    },
  })
);
const npcTickConfig = {
  batchSize: 1,
  maxConsecutiveErrors: 5,
  recordTrajectories: false,
};

mock.module('@feed/db', () => ({
  games: {},
  eq: () => ({}),
  inArray: () => ({}),
  db: {
    game: { findFirst: async () => game },
    update: () => ({ set: () => ({ where: async () => [] }) }),
  },
}));
mock.module('@feed/api', () => ({
  DistributedLockService: {
    acquireLock: async () => true,
    releaseLock: async () => {},
  },
  verifyCronAuth: () => true,
  relayCronToStaging: async () => ({ forwarded: false }),
  getCacheOrFetch: async () => game,
  recordCronExecution: () => {},
  withErrorHandling: (handler: (req: NextRequest) => Promise<Response>) =>
    handler,
}));
mock.module('@feed/agents', () => ({
  agentRuntimeManager: { getRuntime: async () => ({}), hasRuntime: () => true },
  autonomousCoordinator: { executeAutonomousTick: executeTick },
  agentService: { createLog: async () => {}, deductPoints: async () => {} },
  npcBootstrapService: { bootstrapNpc: async () => {} },
  acquireAgentLock: async () => true,
  releaseAgentLock: async () => {},
  withAgentExecutionLease: async <T>(
    _id: string,
    _owner: string,
    work: (signal: AbortSignal) => Promise<T>
  ) => work(new AbortController().signal),
}));
mock.module('@feed/engine', () => ({
  NPC_TICK_CONFIG: npcTickConfig,
  StaticDataRegistry: { getAllActors: () => [fixtureNpc] },
  isActiveHour: () => true,
  getRecentlyMentionedActorIds: async () => [],
  getActiveEventsForPosting: async () => ({
    activeEventQuestionIds: [],
    activeEvents: [],
  }),
  postingProbabilityService: {
    getStateMap: async () => new Map(),
    calculate: () => 1,
    weightedSample: () => [],
  },
  npcMemoryService: { updateActivityState: async () => {} },
  ActorSocialActions: { processRandomSocialActions: async () => [] },
  FollowingMechanics: {
    processProactiveFollowing: async () => ({ followsCreated: 0 }),
    processUnfollowChecks: async () => 0,
  },
  secureRandom: () => 0.5,
}));
mock.module(
  new URL(
    '../../../../apps/web/src/lib/engine/ensure-engine-services.ts',
    import.meta.url
  ).pathname,
  () => ({ ensureEngineServices: () => {} })
);

const npcRoute = await import(
  '../../../../apps/web/src/app/api/cron/npc-tick/route'
);

describe('product tick training recording boundary', () => {
  beforeEach(() => {
    executeTick.mockClear();
    npcTickConfig.recordTrajectories = false;
  });

  test.each([false, true])('NPC tick honors recording=%s', async (enabled) => {
    npcTickConfig.recordTrajectories = enabled;
    const response = await npcRoute.POST(
      new NextRequest('http://localhost/api/cron/npc-tick', { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect(executeTick).toHaveBeenCalledTimes(1);
    expect(executeTick.mock.calls[0]?.slice(2, 4)).toEqual([enabled, true]);
  });
});
