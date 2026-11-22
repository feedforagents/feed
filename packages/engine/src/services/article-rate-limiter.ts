/**
 * Article Rate Limiter Service
 *
 * Prevents article flooding by enforcing hourly limits across all generation sources.
 * Articles are generated from multiple places (game-tick, organization-tick, arc events)
 * and this service ensures the total doesn't overwhelm the feed.
 *
 * @module services/article-rate-limiter
 */

import { and, db, eq, gte, isNull, lte, posts, sql } from '@feed/db';
import { logger } from '@feed/shared';

/**
 * Configuration for article rate limiting
 */
export interface ArticleRateLimitConfig {
  /** Maximum articles allowed per hour across all sources */
  maxArticlesPerHour: number;
  /** Time window in milliseconds (default: 1 hour) */
  windowMs?: number;
}

/**
 * Default rate limit for articles per hour.
 * Used when env var is missing or invalid.
 */
const DEFAULT_MAX_ARTICLES_PER_HOUR = 2;

/**
 * Parse a positive integer environment variable.
 * A missing/empty value uses the default; a malformed value (non-integer,
 * trailing junk, zero or negative) is a configuration error and throws.
 */
function parsePositiveIntEnvVar(
  envVarName: string,
  defaultValue: number
): number {
  const envValue = process.env[envVarName]?.trim();

  if (!envValue) {
    return defaultValue;
  }

  if (!/^\d+$/.test(envValue) || Number(envValue) <= 0) {
    throw new Error(
      `Invalid ${envVarName}: "${envValue}" must be a positive integer`
    );
  }

  return Number(envValue);
}

/**
 * Validate limiter configuration at construction time.
 */
function validateLimiterConfig(config: {
  maxArticlesPerHour: number;
  windowMs: number;
}): void {
  if (!Number.isInteger(config.maxArticlesPerHour)) {
    throw new Error('maxArticlesPerHour must be a finite integer');
  }
  if (config.maxArticlesPerHour <= 0) {
    throw new Error('maxArticlesPerHour must be a positive number');
  }
  if (!Number.isFinite(config.windowMs)) {
    throw new Error('windowMs must be finite');
  }
  if (config.windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }
}

/**
 * Non-deleted articles published within [now - windowMs, now].
 * Future-dated rows are excluded.
 */
function recentArticlesWindow(now: Date, windowMs: number) {
  return and(
    eq(posts.type, 'article'),
    gte(posts.timestamp, new Date(now.getTime() - windowMs)),
    lte(posts.timestamp, now),
    isNull(posts.deletedAt)
  );
}

async function countRecentArticles(windowMs: number): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(recentArticlesWindow(new Date(), windowMs));

  return result?.count ?? 0;
}

/**
 * Parse the ARTICLE_RATE_LIMIT_PER_HOUR environment variable.
 */
function parseMaxArticlesPerHour(): number {
  return parsePositiveIntEnvVar(
    'ARTICLE_RATE_LIMIT_PER_HOUR',
    DEFAULT_MAX_ARTICLES_PER_HOUR
  );
}

/**
 * Default configuration for article rate limiting.
 *
 * The limit can be configured via environment variable:
 * - ARTICLE_RATE_LIMIT_PER_HOUR: Max articles per hour (default: 2)
 *
 * @remarks
 * A limit of 2 articles per hour provides a calmer news feed:
 * - ~1 article every 30 minutes on average
 * - Prevents article flooding that drowns out user/agent content
 * - Sustainable for LLM cost management
 * - Articles are high-effort content that should feel special
 */
const DEFAULT_CONFIG: Required<ArticleRateLimitConfig> = {
  maxArticlesPerHour: parseMaxArticlesPerHour(),
  windowMs: 60 * 60 * 1000, // 1 hour
};

/**
 * Article Rate Limiter Service
 *
 * Tracks article creation across all sources and enforces hourly limits.
 * Uses database queries to count recent articles, ensuring consistency
 * across multiple cron job instances.
 */
export class ArticleRateLimiterService {
  private config: Required<ArticleRateLimitConfig>;

  constructor(config: Partial<ArticleRateLimitConfig> = {}) {
    this.config = {
      maxArticlesPerHour:
        config.maxArticlesPerHour ?? DEFAULT_CONFIG.maxArticlesPerHour,
      windowMs: config.windowMs ?? DEFAULT_CONFIG.windowMs,
    } satisfies Required<ArticleRateLimitConfig>;
    validateLimiterConfig(this.config);
  }

  /**
   * Get the count of articles created in the current time window
   */
  async getRecentArticleCount(): Promise<number> {
    return countRecentArticles(this.config.windowMs);
  }

  /**
   * Check if more articles can be generated
   *
   * @returns Object with allowed status and remaining slots
   */
  async canGenerateArticle(): Promise<{
    allowed: boolean;
    currentCount: number;
    maxAllowed: number;
    remaining: number;
  }> {
    const currentCount = await this.getRecentArticleCount();
    const remaining = Math.max(
      0,
      this.config.maxArticlesPerHour - currentCount
    );

    const result = {
      allowed: currentCount < this.config.maxArticlesPerHour,
      currentCount,
      maxAllowed: this.config.maxArticlesPerHour,
      remaining,
    };

    if (!result.allowed) {
      logger.debug(
        'Article generation blocked by rate limit',
        {
          currentCount,
          maxAllowed: this.config.maxArticlesPerHour,
          windowMinutes: Math.round(this.config.windowMs / 60000),
        },
        'ArticleRateLimiter'
      );
    }

    return result;
  }

  /**
   * Earliest time, in Unix milliseconds, when the current window has room.
   */
  async getNextAvailableAt(): Promise<number> {
    const { maxArticlesPerHour, windowMs } = this.config;
    const now = new Date();
    const [lastOccupiedSlot] = await db
      .select({ timestamp: posts.timestamp })
      .from(posts)
      .where(recentArticlesWindow(now, windowMs))
      .orderBy(sql`${posts.timestamp} desc`)
      .limit(1)
      .offset(maxArticlesPerHour - 1);

    // The start of the current window is inclusive.
    return lastOccupiedSlot
      ? lastOccupiedSlot.timestamp.getTime() + windowMs + 1
      : now.getTime();
  }

  /**
   * Get the number of articles that can still be generated this hour
   */
  async getRemainingSlots(): Promise<number> {
    const { remaining } = await this.canGenerateArticle();
    return remaining;
  }

  /**
   * Check rate limit and log status
   * Convenience method for use at the start of article generation
   */
  async checkAndLog(source: string): Promise<boolean> {
    const { allowed, currentCount, maxAllowed, remaining } =
      await this.canGenerateArticle();

    if (allowed) {
      logger.info(
        `Article rate limit check passed`,
        {
          source,
          currentCount,
          maxAllowed,
          remaining,
        },
        'ArticleRateLimiter'
      );
    } else {
      logger.warn(
        `Article rate limit exceeded - skipping generation`,
        {
          source,
          currentCount,
          maxAllowed,
        },
        'ArticleRateLimiter'
      );
    }

    return allowed;
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<ArticleRateLimitConfig> {
    return { ...this.config };
  }
}

/**
 * Singleton instance with default config (2 articles per hour, configurable via env).
 *
 * @remarks
 * **Concurrency Note**: The check-then-act pattern (`canGenerateArticle()` followed
 * by article creation) is NOT atomic. Concurrent generators can each pass the
 * check and exceed the configured limit; the overrun is not bounded. This is a
 * feed-quality budget, not a hard cap. Strict enforcement would need a durable
 * claim (e.g. row lock or distributed lock) shared by all generators.
 */
export const articleRateLimiter = new ArticleRateLimiterService();

/**
 * Create a custom rate limiter with different limits.
 * Configuration is validated by the constructor.
 *
 * @example
 * ```typescript
 * const limiter = createArticleRateLimiter({ maxArticlesPerHour: 5 });
 * const { allowed } = await limiter.canGenerateArticle();
 * if (allowed) {
 *   // Generate article
 * }
 * ```
 */
export function createArticleRateLimiter(
  config: Partial<ArticleRateLimitConfig>
): ArticleRateLimiterService {
  return new ArticleRateLimiterService(config);
}

/**
 * Parse the BREAKING_RATE_LIMIT_PER_HOUR environment variable.
 *
 * Posts have no breaking/regular distinction, so the breaking limiter counts
 * ALL articles. Its default threshold is therefore the configured regular
 * limit plus one extra slot (one breaking article on top of the regular
 * budget). Breaking articles bypass the regular limiter (`skipRateLimit`).
 */
function parseBreakingRateLimit(): number {
  return parsePositiveIntEnvVar(
    'BREAKING_RATE_LIMIT_PER_HOUR',
    DEFAULT_CONFIG.maxArticlesPerHour + 1
  );
}

/**
 * Breaking Article Rate Limiter Service
 *
 * Counts ALL non-deleted articles in the window (posts have no breaking flag)
 * plus in-flight reservations held by this process. The threshold defaults to
 * the regular limit + 1 (see parseBreakingRateLimit).
 *
 * Callers reserve a slot before generation and must release it once the
 * article is persisted (the post row then counts) or generation fails.
 *
 * @remarks
 * **Concurrency Note**: reservations only serialize callers within one process
 * (and the count is awaited before the reservation is recorded). Concurrent
 * processes can exceed the limit.
 */
export class BreakingArticleRateLimiterService {
  private readonly maxArticlesPerHour: number;
  private readonly windowMs: number;
  /** In-flight reservations for TOCTOU protection within a single process run */
  private reservations: Map<string, number> = new Map();

  constructor(config: { maxArticlesPerHour?: number; windowMs?: number } = {}) {
    this.maxArticlesPerHour =
      config.maxArticlesPerHour ?? parseBreakingRateLimit();
    this.windowMs = config.windowMs ?? 60 * 60 * 1000; // 1 hour
    validateLimiterConfig({
      maxArticlesPerHour: this.maxArticlesPerHour,
      windowMs: this.windowMs,
    });
  }

  /** Clean up stale in-flight reservations (older than windowMs) */
  private cleanupReservations(): void {
    const windowStart = Date.now() - this.windowMs;
    for (const [id, ts] of this.reservations) {
      if (ts <= windowStart) {
        this.reservations.delete(id);
      }
    }
  }

  /**
   * Get the count of articles created in the current time window from the DB,
   * plus any in-flight reservations.
   */
  async getRecentArticleCount(): Promise<number> {
    this.cleanupReservations();
    const dbCount = await countRecentArticles(this.windowMs);
    return dbCount + this.reservations.size;
  }

  /**
   * Check if more breaking articles can be generated.
   */
  async canGenerateArticle(): Promise<{
    allowed: boolean;
    currentCount: number;
    maxAllowed: number;
    remaining: number;
  }> {
    const currentCount = await this.getRecentArticleCount();
    const remaining = Math.max(0, this.maxArticlesPerHour - currentCount);

    const result = {
      allowed: currentCount < this.maxArticlesPerHour,
      currentCount,
      maxAllowed: this.maxArticlesPerHour,
      remaining,
    };

    if (!result.allowed) {
      logger.debug(
        'Breaking article generation blocked by rate limit',
        {
          currentCount,
          maxAllowed: this.maxArticlesPerHour,
          windowMinutes: Math.round(this.windowMs / 60000),
        },
        'BreakingArticleRateLimiter'
      );
    }

    return result;
  }

  /**
   * Try to reserve a slot for a breaking article.
   * Reserves a short-lived in-process slot to prevent race conditions.
   * After persisting the article, the slot is superseded by the DB record.
   *
   * @returns A unique reservationId if a slot was reserved, or null if rate limit would be exceeded
   */
  async tryReserveSlot(): Promise<string | null> {
    this.cleanupReservations();

    const currentCount = await this.getRecentArticleCount();
    if (currentCount >= this.maxArticlesPerHour) {
      logger.debug(
        'Breaking article slot reservation failed - rate limit reached',
        { currentCount, maxAllowed: this.maxArticlesPerHour },
        'BreakingArticleRateLimiter'
      );
      return null;
    }

    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, Date.now());

    logger.debug(
      'Breaking article slot reserved',
      {
        reservationId,
        currentCount: currentCount + 1,
        maxAllowed: this.maxArticlesPerHour,
      },
      'BreakingArticleRateLimiter'
    );

    return reservationId;
  }

  /**
   * Release a previously reserved slot.
   * Call this once the article is persisted (the post row now counts) or if
   * generation fails.
   *
   * @param reservationId - The unique ID returned by tryReserveSlot()
   * @returns true if the slot was released, false if the reservationId was not found
   */
  releaseSlot(reservationId: string): boolean {
    const existed = this.reservations.delete(reservationId);

    logger.debug(
      existed
        ? 'Breaking article slot released'
        : 'Breaking article slot release failed - reservation not found',
      { reservationId },
      'BreakingArticleRateLimiter'
    );

    return existed;
  }

  /**
   * Get the number of breaking articles that can still be generated this hour.
   */
  async getRemainingSlots(): Promise<number> {
    const { remaining } = await this.canGenerateArticle();
    return remaining;
  }

  /**
   * Get current configuration
   */
  getConfig(): { maxArticlesPerHour: number; windowMs: number } {
    return {
      maxArticlesPerHour: this.maxArticlesPerHour,
      windowMs: this.windowMs,
    };
  }

  /**
   * Reset in-flight reservations (for testing purposes)
   */
  reset(): void {
    this.reservations.clear();
  }
}

/**
 * Rate limiter for breaking articles (event-triggered).
 *
 * Counts all articles in the DB window plus this process's in-flight
 * reservations; by default allows the regular limit + 1 articles/hour total.
 * Configure via BREAKING_RATE_LIMIT_PER_HOUR environment variable.
 */
export const breakingArticleRateLimiter =
  new BreakingArticleRateLimiterService();
