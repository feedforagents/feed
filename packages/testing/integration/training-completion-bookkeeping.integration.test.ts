import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, eq, inArray, trainingBatches, trajectories } from '@feed/db';
import { AutomationPipeline } from '@feed/training/training';

const trajectoryIds: string[] = [];
const batchIds: string[] = [];
const cleanupSpies: Array<{ mockRestore: () => void }> = [];

async function createTrajectory(usedInTraining = false) {
  const id = `completion-${randomUUID()}`;
  trajectoryIds.push(id);
  await db.insert(trajectories).values({
    id,
    trajectoryId: id,
    agentId: 'ailon-musk',
    startTime: new Date(),
    endTime: new Date(),
    durationMs: 0,
    stepsJson: '[]',
    rewardComponentsJson: '{}',
    metricsJson: '{}',
    metadataJson: '{}',
    totalReward: 0,
    episodeLength: 0,
    finalStatus: 'completed',
    usedInTraining,
    trainedInBatch: usedInTraining ? 'previous-batch' : null,
    updatedAt: new Date(),
  });
  return id;
}

async function createBatch(ids: string[], status = 'completed') {
  const id = `completion-${randomUUID()}`;
  const batchId = `${id}-job`;
  batchIds.push(id);
  await db.insert(trainingBatches).values({
    id,
    batchId,
    baseModel: 'test-fixture',
    modelVersion: 'test-fixture',
    trajectoryIds: JSON.stringify(ids),
    rewardsJson: '[]',
    status,
  });
  return { id, batchId };
}

function activePipeline(batchId: string) {
  const pipeline = new AutomationPipeline();
  const lifecycle = pipeline as never as {
    currentTrainingJob: string | null;
    cleanupExportFiles: (id: string) => Promise<void>;
  };
  lifecycle.currentTrainingJob = batchId;
  // Isolate filesystem cleanup; all batch reads and trajectory writes stay real.
  const cleanup = spyOn(lifecycle, 'cleanupExportFiles').mockResolvedValue(
    undefined
  );
  cleanupSpies.push(cleanup);
  return { pipeline, lifecycle, cleanup };
}

async function consumption(id: string) {
  const [row] = await db
    .select({
      usedInTraining: trajectories.usedInTraining,
      trainedInBatch: trajectories.trainedInBatch,
    })
    .from(trajectories)
    .where(eq(trajectories.trajectoryId, id));
  return row;
}

afterEach(async () => {
  for (const spy of cleanupSpies.splice(0)) spy.mockRestore();
  if (trajectoryIds.length > 0) {
    await db
      .delete(trajectories)
      .where(inArray(trajectories.trajectoryId, trajectoryIds.splice(0)));
  }
  if (batchIds.length > 0) {
    await db
      .delete(trainingBatches)
      .where(inArray(trainingBatches.id, batchIds.splice(0)));
  }
});

describe('Completed training consumption bookkeeping', () => {
  test('consumes exactly the recorded batch before cleanup and preserves earlier provenance', async () => {
    const included = await createTrajectory();
    const previouslyUsed = await createTrajectory(true);
    const unrelated = await createTrajectory();
    const batch = await createBatch([included, previouslyUsed]);
    const { pipeline, lifecycle, cleanup } = activePipeline(batch.batchId);
    cleanup.mockImplementation(async () => {
      expect(await consumption(included)).toEqual({
        usedInTraining: true,
        trainedInBatch: batch.id,
      });
      expect(lifecycle.currentTrainingJob).toBe(batch.batchId);
    });

    await pipeline.runAutomationCycle();

    expect(await consumption(previouslyUsed)).toEqual({
      usedInTraining: true,
      trainedInBatch: 'previous-batch',
    });
    expect(await consumption(unrelated)).toEqual({
      usedInTraining: false,
      trainedInBatch: null,
    });
    expect(cleanup).toHaveBeenCalledWith(batch.batchId);
    expect(lifecycle.currentTrainingJob).toBeNull();
  });

  test('failed training leaves its recorded trajectories unused', async () => {
    const included = await createTrajectory();
    const batch = await createBatch([included], 'failed');
    const { pipeline, lifecycle, cleanup } = activePipeline(batch.batchId);

    await pipeline.runAutomationCycle();

    expect(await consumption(included)).toEqual({
      usedInTraining: false,
      trainedInBatch: null,
    });
    expect(cleanup).toHaveBeenCalledWith(batch.batchId);
    expect(lifecycle.currentTrainingJob).toBeNull();
  });

  test('cleanup failure retains the job and a retry safely repeats consumption bookkeeping', async () => {
    const included = await createTrajectory();
    const unrelated = await createTrajectory();
    const batch = await createBatch([included]);
    const { pipeline, lifecycle, cleanup } = activePipeline(batch.batchId);
    cleanup.mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(pipeline.runAutomationCycle()).rejects.toThrow(
      'cleanup failed'
    );
    expect(lifecycle.currentTrainingJob).toBe(batch.batchId);
    expect(await consumption(included)).toEqual({
      usedInTraining: true,
      trainedInBatch: batch.id,
    });

    await pipeline.runAutomationCycle();

    expect(await consumption(included)).toEqual({
      usedInTraining: true,
      trainedInBatch: batch.id,
    });
    expect(await consumption(unrelated)).toEqual({
      usedInTraining: false,
      trainedInBatch: null,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(lifecycle.currentTrainingJob).toBeNull();
  });
});
