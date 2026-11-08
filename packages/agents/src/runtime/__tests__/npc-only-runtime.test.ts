import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { StaticDataRegistry } from '@feed/engine';
import { getAgentContext } from '../../autonomous/agent-context';
import { MultiStepExecutor } from '../../autonomous/MultiStepExecutor';
import { agentRegistry } from '../../services/agent-registry.service';
import type { AgentRegistration } from '../../types/agent-registry';

let registration: { type: string; agentId?: string } | null = null;
let getAgentById = spyOn(agentRegistry, 'getAgentById');

const { AgentRuntimeManager } = await import('../AgentRuntimeManager');
const { AutonomousCoordinator } = await import(
  '../../autonomous/AutonomousCoordinator'
);

const manager = AgentRuntimeManager.getInstance();

beforeEach(() => {
  getAgentById = spyOn(agentRegistry, 'getAgentById').mockImplementation(
    async () => registration as AgentRegistration | null
  );
});

afterEach(() => {
  registration = null;
  getAgentById.mockRestore();
});

describe('NPC-only hosted runtime', () => {
  test.each([
    'USER_CONTROLLED',
    'EXTERNAL',
  ])('rejects a %s registry entry', async (type) => {
    registration = { type };
    await expect(manager.getRuntime('retired-hosted-agent')).rejects.toThrow(
      'Only registered NPCs can run in Feed'
    );
    expect(getAgentById).toHaveBeenCalledTimes(1);
  });

  test('does not fall back to a User record without an NPC registration', async () => {
    await expect(manager.getRuntime('legacy-user-agent')).rejects.toThrow(
      'Only registered NPCs can run in Feed'
    );
  });

  test('resolves an existing world character for NPC actions', async () => {
    const actor = StaticDataRegistry.getAllActors()[0];
    expect(actor).toBeDefined();
    const context = await getAgentContext(actor!.id);
    expect(context).toEqual({
      agentUserId: actor!.id,
      displayName: actor!.name,
      isNpc: true,
      lifetimePnL: 0,
    });
  });

  test('autonomous services cannot resolve a legacy User identity', async () => {
    await expect(getAgentContext('legacy-user-agent')).rejects.toThrow(
      'Only NPCs can execute autonomous actions'
    );
  });

  test('direct executor refuses User identities before accessing runtime', async () => {
    await expect(
      new MultiStepExecutor().execute('legacy-user-agent', {} as IAgentRuntime)
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
  });

  test('direct executor refuses an explicit non-NPC tick', async () => {
    const actor = StaticDataRegistry.getAllActors()[0]!;
    await expect(
      new MultiStepExecutor().execute(actor.id, {} as IAgentRuntime, false)
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
  });

  test('runtime identity must match the canonical NPC actor', async () => {
    const actor = StaticDataRegistry.getAllActors()[0]!;
    const runtime = { agentId: 'another-identity' } as IAgentRuntime;
    await expect(
      new MultiStepExecutor().execute(actor.id, runtime)
    ).rejects.toThrow('NPC runtime does not match actor');
    await expect(
      new AutonomousCoordinator().executeAutonomousTick(actor.id, runtime)
    ).rejects.toThrow('NPC runtime does not match actor');
  });

  test('NPC aliases cannot be used as database actor IDs', async () => {
    const actor = StaticDataRegistry.getAllActors().find(
      (entry) => entry.username
    );
    expect(actor).toBeDefined();
    const alias = actor!.username!.toUpperCase();
    expect(StaticDataRegistry.getActor(alias)?.id).toBe(actor!.id);
    await expect(
      new MultiStepExecutor().execute(alias, {} as IAgentRuntime)
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
    await expect(
      new AutonomousCoordinator().executeAutonomousTick(
        alias,
        {} as IAgentRuntime
      )
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
    await expect(getAgentContext(alias)).rejects.toThrow(
      'Only NPCs can execute autonomous actions'
    );
  });

  test('runtime manager rejects an NPC registration using an alias', async () => {
    const actor = StaticDataRegistry.getAllActors().find(
      (entry) => entry.username
    )!;
    const alias = actor.username!.toUpperCase();
    registration = { type: 'NPC', agentId: alias };
    await expect(manager.getRuntime(alias)).rejects.toThrow(
      'Only registered NPCs can run in Feed'
    );
  });

  test('coordinator refuses user-controlled execution before running actions', async () => {
    const coordinator = new AutonomousCoordinator();
    await expect(
      coordinator.executeAutonomousTick(
        'legacy-user-agent',
        {} as IAgentRuntime,
        false,
        false
      )
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
  });

  test('coordinator also rejects an unknown identity marked as an NPC', async () => {
    const coordinator = new AutonomousCoordinator();
    await expect(
      coordinator.executeAutonomousTick(
        'not-a-world-character',
        {} as IAgentRuntime,
        false,
        true
      )
    ).rejects.toThrow('Only NPCs can execute autonomous ticks');
  });
});
