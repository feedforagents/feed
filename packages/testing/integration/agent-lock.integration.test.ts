import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  AGENT_LOCK_DURATION_MS,
  acquireAgentLock,
  checkAgentLock,
  createAgentLockOwner,
  releaseAgentLock,
} from '@feed/agents/services/agent-lock-service';
import { db } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

function getAgentLockId(agentId: string) {
  return `agent-tick-${agentId}`;
}

describe('Agent Lock Service Integration', () => {
  let testAgentId1: string;
  let testAgentId2: string;

  beforeAll(async () => {
    testAgentId1 = await generateSnowflakeId();
    testAgentId2 = await generateSnowflakeId();
  });

  afterAll(async () => {
    await db.generationLock.deleteMany({
      where: {
        id: {
          in: [getAgentLockId(testAgentId1), getAgentLockId(testAgentId2)],
        },
      },
    });
  });

  beforeEach(async () => {
    await db.generationLock.deleteMany({
      where: {
        id: {
          in: [getAgentLockId(testAgentId1), getAgentLockId(testAgentId2)],
        },
      },
    });
  });

  test('should acquire lock successfully when no lock exists', async () => {
    const processId = 'test-process-1';
    const acquired = await acquireAgentLock(testAgentId1, processId);

    expect(acquired).toBe(true);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });

    expect(lock).toBeTruthy();
    expect(lock?.lockedBy).toBe(processId);
    expect(lock?.operation).toBe('agent-tick');
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await releaseAgentLock(testAgentId1, processId);
  });

  test('should prevent concurrent lock acquisition', async () => {
    const processId1 = 'test-process-1';
    const processId2 = 'test-process-2';

    expect(await acquireAgentLock(testAgentId1, processId1)).toBe(true);
    expect(await acquireAgentLock(testAgentId1, processId2)).toBe(false);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(processId1);

    await releaseAgentLock(testAgentId1, processId1);
  });

  test('should release lock properly', async () => {
    const processId = 'test-process-release';

    await acquireAgentLock(testAgentId1, processId);
    await releaseAgentLock(testAgentId1, processId);

    expect(
      await db.generationLock.findUnique({
        where: { id: getAgentLockId(testAgentId1) },
      })
    ).toBeNull();

    expect(await acquireAgentLock(testAgentId1, processId)).toBe(true);
    await releaseAgentLock(testAgentId1, processId);
  });

  test('should recover expired locks', async () => {
    await db.generationLock.create({
      data: {
        id: getAgentLockId(testAgentId1),
        lockedBy: 'crashed-process',
        lockedAt: new Date(Date.now() - 20 * 60 * 1000),
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
        operation: 'agent-tick',
      },
    });

    const processId = 'recovery-process';
    expect(await acquireAgentLock(testAgentId1, processId)).toBe(true);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(processId);
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await releaseAgentLock(testAgentId1, processId);
  });

  test('should keep locks independent per agent', async () => {
    const processId1 = 'test-process-agent1';
    const processId2 = 'test-process-agent2';

    expect(await acquireAgentLock(testAgentId1, processId1)).toBe(true);
    expect(await acquireAgentLock(testAgentId2, processId2)).toBe(true);

    const lock1 = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    const lock2 = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId2) },
    });

    expect(lock1?.lockedBy).toBe(processId1);
    expect(lock2?.lockedBy).toBe(processId2);

    await releaseAgentLock(testAgentId1, processId1);
    await releaseAgentLock(testAgentId2, processId2);
  });

  test('should handle race conditions gracefully', async () => {
    const processes = ['race-1', 'race-2', 'race-3', 'race-4', 'race-5'];
    const acquisitions = await Promise.all(
      processes.map((processId) => acquireAgentLock(testAgentId1, processId))
    );

    expect(acquisitions.filter(Boolean)).toHaveLength(1);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock).toBeTruthy();
    expect(processes).toContain(lock!.lockedBy);

    await releaseAgentLock(testAgentId1, lock!.lockedBy);
  });

  test('should generate unique serverless-safe process IDs', async () => {
    expect(await acquireAgentLock(testAgentId1, createAgentLockOwner())).toBe(
      true
    );

    const firstLock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(firstLock?.lockedBy).toMatch(/^serverless-\d+-[a-f0-9]{16}$/);

    await releaseAgentLock(testAgentId1, firstLock!.lockedBy);

    expect(await acquireAgentLock(testAgentId1, createAgentLockOwner())).toBe(
      true
    );

    const secondLock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(secondLock?.lockedBy).toMatch(/^serverless-\d+-[a-f0-9]{16}$/);
    expect(secondLock?.lockedBy).not.toBe(firstLock?.lockedBy);

    await releaseAgentLock(testAgentId1, secondLock!.lockedBy);
  });

  test('should check lock status correctly', async () => {
    expect(await checkAgentLock(testAgentId1)).toBeNull();

    const processId = 'check-test-process';
    await acquireAgentLock(testAgentId1, processId);

    const lockStatus = await checkAgentLock(testAgentId1);
    expect(lockStatus).toBeTruthy();
    expect(lockStatus?.id).toBe(getAgentLockId(testAgentId1));
    expect(lockStatus?.lockedBy).toBe(processId);
    expect(lockStatus?.operation).toBe('agent-tick');

    await releaseAgentLock(testAgentId1, processId);
    expect(await checkAgentLock(testAgentId1)).toBeNull();
  });

  test('should only allow the lock owner to release', async () => {
    const ownerProcess = 'lock-owner';
    const intruderProcess = 'intruder';

    await acquireAgentLock(testAgentId1, ownerProcess);
    await releaseAgentLock(testAgentId1, intruderProcess);

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    expect(lock?.lockedBy).toBe(ownerProcess);

    await releaseAgentLock(testAgentId1, ownerProcess);

    expect(
      await db.generationLock.findUnique({
        where: { id: getAgentLockId(testAgentId1) },
      })
    ).toBeNull();
  });

  test('should set lock expiry timing correctly', async () => {
    await acquireAgentLock(testAgentId1, 'expiry-test');

    const lock = await db.generationLock.findUnique({
      where: { id: getAgentLockId(testAgentId1) },
    });
    const expiryDuration = lock!.expiresAt.getTime() - Date.now();
    const buffer = 5000;

    expect(expiryDuration).toBeGreaterThan(AGENT_LOCK_DURATION_MS - buffer);
    expect(expiryDuration).toBeLessThan(AGENT_LOCK_DURATION_MS + buffer);

    await releaseAgentLock(testAgentId1, 'expiry-test');
  });
});
