import type { Plugin } from '@elizaos/core';
import { sharedChatContextEvaluator } from './evaluators/shared-chat-context';
import { goalsProvider } from './providers/goals';
import { headlinesProvider } from './providers/headlines';
import {
  livePlayerRosterProvider,
  recentRelevantGroupContextProvider,
  sharedChatFactsProvider,
} from './providers/social-context';
import { workingMemoryProvider } from './providers/working-memory';

/** Native NPC context. Autonomous actions run through MultiStepExecutor. */
export const npcFeedPlugin: Plugin = {
  name: 'feed',
  description: 'Database-backed game context for Feed NPCs',
  providers: [
    goalsProvider,
    headlinesProvider,
    sharedChatFactsProvider,
    recentRelevantGroupContextProvider,
    livePlayerRosterProvider,
    workingMemoryProvider,
  ],
  evaluators: [sharedChatContextEvaluator],
};
