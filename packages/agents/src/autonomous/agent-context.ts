/**
 * Shared Agent Context Resolution
 *
 * Provides utilities for resolving NPC identity.
 * Eliminates duplicate boilerplate across autonomous services.
 */

import { StaticDataRegistry } from '@feed/engine';

export interface AgentContext {
  agentUserId: string;
  displayName: string;
  isNpc: boolean;
  /** Lifetime P&L (0 for NPCs) */
  lifetimePnL: number;
}

/**
 * Resolve agent context from user ID.
 *
 * Resolves world characters from StaticDataRegistry.
 *
 * @param agentUserId - Agent user ID
 * @returns Agent context with display name, NPC status, and P&L
 * @throws Error if agent not found and not an NPC
 */
export async function getAgentContext(
  agentUserId: string
): Promise<AgentContext> {
  const npcActor = StaticDataRegistry.getActor(agentUserId);
  if (npcActor?.id !== agentUserId) {
    throw new Error(`Only NPCs can execute autonomous actions: ${agentUserId}`);
  }

  return {
    agentUserId,
    displayName: npcActor.name,
    isNpc: true,
    lifetimePnL: 0,
  };
}
