/**
 * Autonomous Agent Services
 *
 * Centralized exports for all autonomous agent behaviors including trading,
 * posting, commenting, messaging, and batch response processing.
 *
 * @packageDocumentation
 */

export {
  AutonomousCoordinator,
  type AutonomousTickResult,
  autonomousCoordinator,
} from './AutonomousCoordinator';
// Agent context utilities
export { type AgentContext, getAgentContext } from './agent-context';
export {
  type DirectCommentParams,
  type DirectCommentResult,
  type DirectMessageParams,
  type DirectMessageResult,
  type DirectPostParams,
  type DirectPostResult,
  type DirectTradeParams,
  type DirectTradeResult,
  executeDirectComment,
  executeDirectMessage,
  executeDirectPost,
  executeDirectTrade,
} from './DirectExecutors';
export {
  MultiStepExecutor,
  type MultiStepExecutorResult,
  multiStepExecutor,
} from './MultiStepExecutor';
export {
  type PredictionMarketForTopic,
  TopicDiversityService,
  topicDiversityService,
} from './TopicDiversityService';

// Multi-step decision templates
export {
  ACTION_DEFINITIONS,
  type ActionDefinition,
  type ActionName,
  Actions,
  type ActionTraceResult,
  type AgentTickContext,
  buildMultiStepDecisionPrompt,
  buildMultiStepSummaryPrompt,
  type CreatorInfo,
  type FeatureName,
  Features,
  getAvailableActions,
  getRequiredFeature,
  type MultiStepDecision,
  type PendingChatMessage,
  type PendingCommentReply,
  type PerpMarketContext,
  type PostContext,
  type PostInfo,
  type PredictionMarketContext,
  type ThreadMessage,
} from './templates/multi-step-decision';
