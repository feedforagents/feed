/**
 * Redis Client - Generic interface for any Redis server
 *
 * @description Provides a Redis client that works with any Redis server
 * using the standard Redis protocol via ioredis.
 *
 * Configuration:
 * - In development mode: Automatically connects to redis://localhost:6380 (Docker Compose)
 * - Set REDIS_URL environment variable to connect to any Redis server
 * - Works with local Redis: redis://localhost:6379
 * - Works with Upstash: redis://default:token@hostname:port
 * - Works with any Redis-compatible server
 *
 * Falls back gracefully if Redis is not configured.
 */

import { logger } from '@feed/shared';
import { requestResource } from '@feed/shared/server/request-scope';
import type IORedis from 'ioredis';

// Type for ioredis instance
export type RedisInstance = IORedis;

// Augment globalThis for development hot-reload persistence
declare global {
  // eslint-disable-next-line no-var
  var __redisClient: RedisInstance | null | undefined;
  // eslint-disable-next-line no-var
  var __redisInitPromise: Promise<void> | null | undefined;
  // eslint-disable-next-line no-var
  var __redisInitialized: boolean | undefined;
}

const isBuildTime = process.env.NEXT_PHASE === 'phase-production-build';
// Read the environment live, not once at import time: an integration suite
// flips NODE_ENV after an earlier suite already imported this module, and
// a cached import-time value would keep Redis disabled for the whole
// process even though the live environment now allows it (see
// ensureRedisReady). Build time never changes at runtime, so it stays a
// const.
const isTestEnv = () => process.env.NODE_ENV === 'test';
const isDevEnv = () => process.env.NODE_ENV === 'development';
const isRedisDisabled = () => process.env.FEED_DISABLE_REDIS === '1';

// Use globalThis to persist across hot reloads in development
// This prevents multiple Redis connections from being created
interface RedisState {
  redisClient: RedisInstance | null;
  isInitialized: boolean;
  initializationPromise: Promise<void> | null;
  isClosing: boolean;
}
const sharedState: RedisState = {
  redisClient: isDevEnv() ? (globalThis.__redisClient ?? null) : null,
  isInitialized: isDevEnv() ? (globalThis.__redisInitialized ?? false) : false,
  initializationPromise: isDevEnv()
    ? (globalThis.__redisInitPromise ?? null)
    : null,
  isClosing: false,
};
function state(): RedisState {
  return (
    requestResource<RedisState>(
      'redis',
      () => ({
        redisClient: null,
        isInitialized: false,
        initializationPromise: null,
        isClosing: false,
      }),
      async (resource) => {
        resource.redisClient?.disconnect(false);
      }
    ) ?? sharedState
  );
}

// Default Redis URL for local development (Docker Compose uses port 6380)
const DEFAULT_DEV_REDIS_URL = 'redis://localhost:6380';

// Sync state to globalThis in dev
function syncGlobalState() {
  if (isDevEnv()) {
    globalThis.__redisClient = state().redisClient;
    globalThis.__redisInitialized = state().isInitialized;
    globalThis.__redisInitPromise = state().initializationPromise;
  }
}

/**
 * Initialize Redis client
 *
 * @description Initializes the Redis client using REDIS_URL environment variable.
 * This is called lazily to avoid bundling ioredis in edge runtime.
 */
async function initializeRedis(): Promise<void> {
  if (state().isInitialized || isBuildTime || isTestEnv()) {
    return;
  }
  state().isInitialized = true;
  syncGlobalState();

  if (isRedisDisabled()) {
    logger.info(
      'Redis explicitly disabled via FEED_DISABLE_REDIS=1',
      undefined,
      'Redis'
    );
    return;
  }

  // Use REDIS_URL from env, or default to local Docker Redis in development
  const redisUrl =
    process.env.REDIS_URL || (isDevEnv() ? DEFAULT_DEV_REDIS_URL : undefined);
  if (!redisUrl) {
    logger.info(
      'Redis not configured - caching will use in-memory fallback',
      undefined,
      'Redis'
    );
    logger.info(
      'Set REDIS_URL to connect (e.g., redis://localhost:6379)',
      undefined,
      'Redis'
    );
    return;
  }

  if (!process.env.REDIS_URL && isDevEnv()) {
    logger.info(
      `Using default Redis URL for development: ${DEFAULT_DEV_REDIS_URL}`,
      undefined,
      'Redis'
    );
  }

  // Check if we're in a Node.js environment (not edge runtime)
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    logger.warn(
      'Redis not available in edge runtime - use in-memory fallback or serverless Redis',
      undefined,
      'Redis'
    );
    return;
  }

  // Dynamic import to prevent bundling in edge runtime
  const IORedisModule = await import('ioredis');
  const IORedisClass = IORedisModule.default;

  const client = new IORedisClass(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 100, 2000);
    },
    lazyConnect: true,
    // Keep connection alive for SSE streaming
    keepAlive: 10000,
    // Don't disconnect on idle - needed for long-running SSE connections
    enableReadyCheck: true,
  });

  state().redisClient = client;
  client.on('error', (error: Error) => {
    logger.warn('Redis client error', { error: error.message }, 'Redis');
  });

  try {
    await client.connect();
    syncGlobalState();
    logger.info('Redis client connected', undefined, 'Redis');
  } catch (error) {
    logger.warn(
      'Redis unavailable; continuing with in-memory fallback',
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Redis'
    );
    try {
      client.disconnect(false);
    } catch {
      // Ignore cleanup failures when the connection never became ready.
    }
    state().redisClient = null;
    syncGlobalState();
  }
}

/**
 * Start Redis initialization once, storing the promise so concurrent
 * callers await the same attempt. No-ops when initialization was already
 * attempted or the live environment still forbids it (e.g. NODE_ENV=test
 * at call time), so an earlier call under test does not poison a later
 * call after a suite flips NODE_ENV to development.
 */
function startInitialization(): void {
  if (
    state().initializationPromise ||
    state().isInitialized ||
    isBuildTime ||
    isTestEnv()
  ) {
    return;
  }
  state().initializationPromise = initializeRedis().catch((error: unknown) => {
    logger.warn(
      'Redis initialization failed; continuing without Redis',
      { error: error instanceof Error ? error.message : String(error) },
      'Redis'
    );
    state().redisClient = null;
    syncGlobalState();
  });
  syncGlobalState();
}

// Skip initialization during build time and test
if (isBuildTime || isTestEnv()) {
  logger.info(
    isTestEnv()
      ? 'Test environment detected - skipping Redis initialization'
      : 'Build time detected - skipping Redis initialization',
    undefined,
    'Redis'
  );
} else if (
  process.env.DEPLOYMENT_PLATFORM !== 'cloudflare' &&
  !state().initializationPromise
) {
  // Always attempt initialization - store the promise so callers can await it
  // Only create a new promise if one doesn't already exist (from globalThis)
  startInitialization();
}

/**
 * Check whether a Redis client exists.
 *
 * @description True once a client has been created and connected at least
 * once. It does not guarantee the connection is currently healthy (ioredis
 * may be reconnecting); use ensureRedisReady() when readiness matters.
 *
 * @returns {boolean} True if a Redis client exists
 */
export function isRedisAvailable(): boolean {
  return state().redisClient !== null;
}

/**
 * Get the current Redis client, or null when Redis is not configured or
 * failed to initialize.
 */
export function getRedisClient(): RedisInstance | null {
  return state().redisClient;
}

/**
 * Ensure Redis is ready for use
 *
 * @description Awaits Redis initialization and returns the client.
 * Use this in long-running processes like SSE that need guaranteed
 * Redis availability. Returns null if Redis is not configured or
 * failed to initialize.
 *
 * @returns {Promise<RedisInstance | null>} Redis client or null
 */
export async function ensureRedisReady(): Promise<RedisInstance | null> {
  if (
    process.env.DEPLOYMENT_PLATFORM === 'cloudflare' &&
    !state().initializationPromise
  ) {
    state().initializationPromise = initializeRedis();
  }
  // Lazily (re)initialize when the module was imported while the live
  // environment forbade Redis (NODE_ENV=test), leaving no client and no
  // attempt behind. A caller that flipped the environment since — e.g. an
  // integration suite that sets NODE_ENV=development before its dynamic
  // imports — must be able to start the client now instead of getting a
  // permanent null. initializeRedis() still honors the live environment,
  // so plain test callers still get null.
  if (!state().initializationPromise) {
    startInitialization();
  }
  // Wait for initialization if it's in progress
  if (state().initializationPromise) {
    await state().initializationPromise;
  }

  // Check if client is connected
  const client = state().redisClient;
  if (!client) {
    return null;
  }

  // Check connection status and reconnect if needed
  const status = client.status;
  if (status === 'ready') {
    return client;
  }

  if (status === 'connecting' || status === 'connect') {
    // Wait for connection to complete
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.off('ready', onReady);
        client.off('error', onError);
        reject(new Error('Redis connection timeout'));
      }, 5000);

      const onReady = () => {
        clearTimeout(timeout);
        client.off('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timeout);
        client.off('ready', onReady);
        reject(err);
      };

      client.once('ready', onReady);
      client.once('error', onError);
    });
    return client;
  }

  // If disconnected/closed, try to reconnect
  if (status === 'end' || status === 'close') {
    logger.info(
      'Redis client disconnected, attempting to reconnect',
      { status },
      'Redis'
    );
    try {
      await client.connect();
      return client;
    } catch (err) {
      logger.error(
        'Redis reconnection failed',
        { error: err instanceof Error ? err.message : String(err) },
        'Redis'
      );
      return null;
    }
  }

  return client;
}

/**
 * Safely publish to Redis (no-op if not available)
 *
 * @description Publishes a message to a Redis list. Returns false if Redis
 * is not available. Automatically sets key expiration to 60 seconds.
 *
 * @param {string} channel - Redis key name
 * @param {string} message - Message to publish
 * @returns {Promise<boolean>} True if published successfully, false if Redis unavailable
 */
export async function safePublish(
  channel: string,
  message: string
): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  await client.rpush(channel, message);
  await client.expire(channel, 60);
  return true;
}

/**
 * Safely poll Redis for messages (returns empty array if not available)
 *
 * @description Polls a Redis list for messages, removing them from the queue.
 * Returns empty array if Redis is not available or no messages found.
 *
 * @param {string} channel - Redis key name to poll
 * @param {number} count - Maximum number of messages to retrieve (default: 10)
 * @returns {Promise<string[]>} Array of messages, or empty array if none found/unavailable
 */
export async function safePoll(channel: string, count = 10): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];

  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const item: string | null = await client.lpop(channel);
    if (item === null) break;
    items.push(item);
  }

  return items;
}

/**
 * Cleanup Redis connection on shutdown
 *
 * @description Gracefully closes the Redis connection. Safe to call multiple
 * times. Used during application shutdown to clean up resources.
 *
 * @returns {Promise<void>} Promise that resolves when connection is closed
 */
export async function closeRedis(): Promise<void> {
  const current = state();
  if (current.isClosing) return;
  current.isClosing = true;

  const client = current.redisClient;
  current.redisClient = null;
  syncGlobalState();
  try {
    if (client) {
      const status = client.status;
      if (status === 'ready' || status === 'connect') {
        await client.quit();
        logger.info('Redis connection closed', undefined, 'Redis');
      } else {
        client.disconnect(false);
      }
    }
  } catch (error) {
    logger.warn(
      'Redis quit failed; disconnecting',
      { error: error instanceof Error ? error.message : String(error) },
      'Redis'
    );
    client?.disconnect(false);
  } finally {
    current.isClosing = false;
  }
}

// Cleanup on process exit (only if not build time)
if (
  typeof process !== 'undefined' &&
  !isBuildTime &&
  process.env.DEPLOYMENT_PLATFORM !== 'cloudflare'
) {
  process.on('SIGINT', () => {
    void closeRedis();
  });
  process.on('SIGTERM', () => {
    void closeRedis();
  });
}
