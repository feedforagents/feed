/**
 * Standalone Feed compatibility plugin for Eliza agents.
 * Hosted NPC runtimes register the native plugin in npc.ts.
 *
 * - Providers: read context for the agent (some via the A2A client, some
 *   directly from Feed's database; see `feedPlugin.providers`).
 * - Actions: trading, social and messaging writes executed through the A2A
 *   client (`./actions`), which validates the typed responses.
 * - Runtime wiring: `enhanceRuntimeWithFeed` (integration-a2a-sdk.ts) attaches
 *   the shared A2A client and registers the plugin. When A2A is explicitly
 *   disabled (FEED_DISABLE_A2A), only database-backed providers are
 *   registered and remote actions are omitted.
 */

import type { Plugin } from '@elizaos/core';
import { logger } from '../../shared/logger';
// Import all actions
import {
  buySharesAction,
  closePerpPositionAction,
  commentAction,
  createGroupAction,
  createPostAction,
  likePostAction,
  openPerpPositionAction,
  sellSharesAction,
  sendMessageAction,
} from './actions';
import { sharedChatContextEvaluator } from './evaluators/shared-chat-context';
import { initializeAgentA2AClient } from './integration-a2a-sdk';
// Import all providers
import {
  agentWalletProvider,
  dashboardProvider,
  entityMentionsProvider,
  feedProvider,
  goalsProvider,
  headlinesProvider,
  livePlayerRosterProvider,
  marketMoversProvider,
  marketsProvider,
  messagesProvider,
  notificationsProvider,
  recentRelevantGroupContextProvider,
  sharedChatFactsProvider,
  trendingTopicsProvider,
  userProfileProvider,
  userWalletProvider,
  workingMemoryProvider,
} from './providers';

// Export integration services
export * from './integration';
export { initializeAgentA2AClient } from './integration-a2a-sdk';
export * from './services';
// Export types for external use
export type { FeedRuntime } from './types';

/**
 * Standalone Feed plugin. See the module header for the provider/action split.
 */
export const feedPlugin: Plugin = {
  name: 'feed',
  description:
    'Feed prediction market game integration for AI agents: market, portfolio and social context providers plus trading, social and messaging actions executed via A2A.',

  providers: [
    goalsProvider, // Agent goals, directives, and constraints - highest priority context
    dashboardProvider, // Comprehensive context dashboard - always first
    agentWalletProvider, // Agent's own complete wallet & investments
    marketsProvider,
    marketMoversProvider, // Top gainers and losers
    feedProvider,
    trendingTopicsProvider, // Trending tags and topics (A2A getTrendingTags)
    headlinesProvider, // Recent news headlines
    messagesProvider,
    notificationsProvider,
    sharedChatFactsProvider,
    recentRelevantGroupContextProvider,
    livePlayerRosterProvider,
    userWalletProvider, // Query any user's wallet and positions
    userProfileProvider, // View any user's profile information
    entityMentionsProvider, // Detect and enrich entity mentions (users, companies, stocks)
    workingMemoryProvider, // Persistent cross-tick memory: contacts, facts, thesis, trade reasoning
  ],

  evaluators: [sharedChatContextEvaluator],

  actions: [
    // Trading actions
    buySharesAction,
    sellSharesAction,
    openPerpPositionAction,
    closePerpPositionAction,
    // Social actions
    createPostAction,
    commentAction,
    likePostAction,
    // Messaging actions
    sendMessageAction,
    createGroupAction,
  ],

  services: [], // Services are handled by A2A client
};

/**
 * Initialize the standalone plugin with an A2A client. The A2A client is
 * resolved from the agent's identity via `initializeAgentA2AClient`.
 *
 * Throws if no A2A connection can be established.
 */
export async function initializeFeedPlugin(runtime: {
  a2aClient?: import('./integration-a2a-sdk').FeedA2AClient | null;
  registerPlugin?: (plugin: Plugin) => void | Promise<void>;
  agentId?: string;
}) {
  if (!runtime.agentId) {
    throw new Error('Runtime must have agentId to initialize A2A client');
  }

  const a2aClient = await initializeAgentA2AClient(runtime.agentId);
  if (!a2aClient) throw new Error('An active A2A connection is required');

  runtime.a2aClient = a2aClient;

  if (runtime.registerPlugin) {
    await runtime.registerPlugin(feedPlugin);
    logger.debug('Feed plugin registered with A2A client');
  }

  return { a2aClient, plugin: feedPlugin };
}

export default feedPlugin;
