/**
 * Feed Engine - Client-Safe Exports
 *
 * This module exports utilities that are safe to use in client-side code.
 * It does NOT include any server-only dependencies like Redis, Postgres,
 * or Node.js built-in modules (tls, fs, child_process, etc.)
 *
 * Use this import for React client components:
 * import { PredictionPricing } from '@feed/engine/client';
 */

// Prediction Pricing (pure math, no server dependencies)
// IMPORTANT: Use /client path to avoid pulling in PredictionDbAdapter which imports @feed/db
export {
  calculateExpectedPayout,
  PredictionPricing,
  type ShareCalculation,
  type ShareCalculationWithFees,
} from '@feed/core/markets/prediction/pricing';
// Fee Configuration (pure constants, no dependencies)
export {
  FEE_CONFIG,
  type FeeTransactionType,
  type FeeType,
} from './config/fees';
export {
  calculatePerpPositionMarketValue,
  toNumber,
} from './portfolio-valuation';
// Reputation calculations that are pure functions (no DB)
// Import directly from the pnl-normalizer file to avoid pulling in server-side deps from the barrel export
export {
  calculateConfidenceScore,
  calculateWinRate,
  getTrustLevel,
  normalizePnL,
} from './reputation/pnl-normalizer';
// Common Types (types only)
export type {
  ApiResponse,
  ErrorLike,
  FilterParams,
  JsonRpcParams,
  JsonRpcResult,
  JsonValue,
  LLMResponse,
  LogData,
  PaginatedResponse,
  PaginationParams,
  QueryParams,
  SortOrder,
  SortParams,
  StringRecord,
  WebSocketData,
} from './types/common';
// Market Decision Types (types only, no runtime code)
export type {
  ExecutedTrade,
  MarketAction,
  MarketType,
  TradeImpact,
  TradingDecision,
  TradingExecutionResult,
} from './types/market-decisions';
// Portfolio PnL type (client-safe type module, no runtime deps)
export type { PortfolioPnLSnapshot } from './types/portfolio';
// Shared Game Types (re-exported from types, no server deps)
export type {
  Actor,
  ActorConnection,
  ActorData,
  ActorRelationship,
  ActorState,
  ActorsDatabase,
  ActorTier,
  DayTimeline,
  FeedEvent,
  FeedPost,
  GameHistory,
  GameResolution,
  GameSetup,
  GameState,
  GeneratedGame,
  GenesisGame,
  GroupChat,
  GroupChatMessage,
  LuckChange,
  MoodChange,
  Organization,
  OrgType,
  PostType,
  PriceUpdate,
  Question,
  QuestionOutcome,
  RelationshipType,
  Scenario,
  SelectedActor,
  StockPrice,
  WorldEvent,
} from './types/shared';
export {
  ACTOR_TIERS,
  DAY_RANGES,
  getEscalationLevel,
  ORG_TYPES,
  POST_TYPES,
  RELATIONSHIP_TYPES,
} from './types/shared';
// Utils - Randomization (pure functions)
export {
  pickRandom,
  randomChance,
  randomInt,
  sampleRandom,
  shuffleArray,
} from './utils/randomization';

export interface PortfolioBreakdownSnapshot {
  wallet: number;
  positions: number;
  available: number;
  netPeerTransfers: number;
  originalAmount: number;
  totalAssets: number;
  totalPnL: number;
}
