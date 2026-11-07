/**
 * Agent Plugins
 *
 * Plugin system for extending agent capabilities including A2A integration,
 * LLM providers, trajectory logging, autonomy, and experience tracking.
 *
 * @packageDocumentation
 */

export {
  default as defaultFeedPlugin,
  feedPlugin,
  initializeFeedPlugin,
} from './feed';
export type { FeedRuntime } from './feed/types';
export { groqPlugin } from './groq';
export * from './plugin-agent-core/src';
export * from './plugin-experience/src';
export * from './plugin-trajectory-logger/src';
