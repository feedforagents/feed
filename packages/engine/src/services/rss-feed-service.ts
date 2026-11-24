/**
 * RSS Feed Service
 *
 * Fetches and parses RSS feeds from news sources without requiring API keys.
 * Uses standard RSS/Atom feed formats that are publicly available.
 *
 * @module services/rss-feed-service
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { RSSHeadline } from '@feed/db';
import {
  and,
  db,
  desc,
  eq,
  gte,
  lt,
  parodyHeadlines,
  rssFeedSources,
  rssHeadlines,
  sql,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { parseStringPromise } from 'xml2js';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type Xml2JsFeed = {
  rss?: {
    channel?: Array<{
      title?: JsonValue[];
      item?: Array<Record<string, JsonValue>>;
    }>;
  };
  feed?: {
    title?: JsonValue[];
    entry?: Array<Record<string, JsonValue>>;
  };
};

function extractXmlText(raw: JsonValue | undefined): string | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value =
    typeof first === 'object' &&
    first !== null &&
    !Array.isArray(first) &&
    '_' in first
      ? (first as { _?: JsonValue })._
      : first;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function extractAtomLink(raw: JsonValue | undefined): string | undefined {
  const candidates = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  let fallback: string | undefined;
  for (const candidate of candidates) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      !('$' in candidate)
    ) {
      continue;
    }
    const attrs = (candidate as { $?: { href?: JsonValue; rel?: JsonValue } })
      .$;
    const href =
      typeof attrs?.href === 'string' ? attrs.href.trim() : undefined;
    if (!href) continue;
    const rel = typeof attrs?.rel === 'string' ? attrs.rel.trim() : undefined;
    if (!rel || rel === 'alternate') {
      return href;
    }
    fallback ??= href;
  }
  return fallback;
}

export interface RSSFeedItem {
  title: string;
  link?: string;
  pubDate?: string;
  description?: string;
  content?: string;
  guid?: string;
}

export interface ParsedFeed {
  title: string;
  items: RSSFeedItem[];
}

/**
 * RSS Feed Service
 * Handles fetching, parsing, and storing RSS feed data
 */
export class RSSFeedService {
  /**
   * Fetch and parse RSS feed from URL with exponential retry
   */
  async fetchFeed(
    url: string,
    maxRetries = 3,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<ParsedFeed> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      try {
        // Exponential backoff: 1s, 2s, 4s
        if (attempt > 0) {
          const delayMs = 2 ** (attempt - 1) * 1000;
          logger.info(
            `Retrying RSS feed fetch (attempt ${attempt + 1}/${maxRetries})`,
            { url, delayMs },
            'RSSFeedService'
          );
          await delay(delayMs, undefined, { signal: options.signal });
        }

        const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FeedBot/1.0)',
          },
          signal: options.signal
            ? AbortSignal.any([options.signal, timeout])
            : timeout,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const xmlText = await response.text();
        const parsed = (await parseStringPromise(xmlText)) as Xml2JsFeed;

        // Handle RSS 2.0 format
        if (parsed.rss?.channel?.[0]) {
          const channel = parsed.rss.channel[0];
          return {
            title: extractXmlText(channel.title) || 'Unknown Feed',
            items: (channel.item || []).map(
              (item: Record<string, JsonValue>) => ({
                title: extractXmlText(item.title) ?? '',
                link: extractXmlText(item.link),
                pubDate: extractXmlText(item.pubDate),
                description: extractXmlText(item.description),
                content: extractXmlText(item['content:encoded']),
                guid: extractXmlText(item.guid),
              })
            ),
          };
        }

        // Handle Atom format
        if (parsed.feed?.entry) {
          return {
            title: extractXmlText(parsed.feed.title) || 'Unknown Feed',
            items: (parsed.feed.entry || []).map(
              (entry: Record<string, JsonValue>) => ({
                title: extractXmlText(entry.title) ?? '',
                link: extractAtomLink(entry.link),
                pubDate:
                  extractXmlText(entry.published) ??
                  extractXmlText(entry.updated),
                description: extractXmlText(entry.summary),
                content: extractXmlText(entry.content),
                guid: extractXmlText(entry.id),
              })
            ),
          };
        }

        throw new Error('Unknown feed format');
      } catch (error) {
        options.signal?.throwIfAborted();
        lastError = error as Error;

        if (attempt === maxRetries - 1) {
          // Final retry attempt failed
          logger.error(
            `Failed to fetch RSS feed after ${maxRetries} attempts`,
            { url, error },
            'RSSFeedService'
          );
          throw lastError;
        }

        // Log retry
        logger.warn(
          'RSS feed fetch failed, will retry',
          { url, attempt: attempt + 1, error: (error as Error).message },
          'RSSFeedService'
        );
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError || new Error('Failed to fetch RSS feed');
  }

  /**
   * Fetch all active RSS feeds and store new headlines
   */
  async fetchAllFeeds(
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      attempts?: number;
    } = {}
  ): Promise<{
    fetched: number;
    stored: number;
    errors: number;
  }> {
    const sources = await db
      .select()
      .from(rssFeedSources)
      .where(eq(rssFeedSources.isActive, true));

    logger.info(
      `Fetching ${sources.length} RSS feeds`,
      undefined,
      'RSSFeedService'
    );

    let fetched = 0;
    let stored = 0;
    let errors = 0;

    for (const source of sources) {
      if (options.signal?.aborted) break;

      // A failing source (network/HTTP/parse, after fetchFeed's retries) must
      // not abort the sweep for the remaining independent sources. Record the
      // failure on the source and continue; DB errors below still propagate.
      let feed: ParsedFeed;
      try {
        feed = await this.fetchFeed(source.feedUrl, options.attempts, options);
      } catch (error) {
        if (options.signal?.aborted) break;
        errors++;
        logger.warn(
          'RSS source fetch failed; continuing with remaining sources',
          {
            sourceId: source.id,
            feedUrl: source.feedUrl,
            error: error instanceof Error ? error.message : String(error),
          },
          'RSSFeedService'
        );
        await db
          .update(rssFeedSources)
          .set({ fetchErrors: sql`${rssFeedSources.fetchErrors} + 1` })
          .where(eq(rssFeedSources.id, source.id));
        continue;
      }
      fetched++;

      // Store new headlines (check by link to avoid duplicates)
      for (const item of feed.items) {
        if (options.signal?.aborted) break;
        if (!item.title) continue;

        // Pre-filter: skip non-news garbage before any DB work
        const trimmedTitle = item.title.trim();
        if (trimmedTitle.length < 15) continue; // too short for news
        if (trimmedTitle.length > 500) continue; // paragraph, not headline
        if (/^https?:\/\//i.test(trimmedTitle)) continue; // just a URL
        if (
          /\b(subscribe|newsletter|click here|unsubscribe)\b/i.test(
            trimmedTitle
          )
        )
          continue;

        // Check if we already have this headline
        const existingResult = item.link
          ? await db
              .select({ id: rssHeadlines.id })
              .from(rssHeadlines)
              .where(eq(rssHeadlines.link, item.link))
              .limit(1)
          : [];

        const existing = existingResult[0];

        if (existing) continue;

        // An unparseable pubDate must not abort storage of the whole feed.
        const parsedPubDate = item.pubDate ? new Date(item.pubDate) : null;
        const publishedAt =
          parsedPubDate && !Number.isNaN(parsedPubDate.getTime())
            ? parsedPubDate
            : new Date();

        await db.insert(rssHeadlines).values({
          id: await generateSnowflakeId(),
          sourceId: source.id,
          title: item.title,
          link: item.link || null,
          publishedAt,
          summary: item.description || null,
          content: item.content || null,
          // RSSFeedItem is a plain object with JsonValue-compatible fields (all string/undefined)
          // Convert through unknown first for type safety
          rawData: JSON.parse(JSON.stringify(item)) as JsonValue,
          fetchedAt: new Date(),
        });

        stored++;
      }

      // Update last fetched timestamp
      await db
        .update(rssFeedSources)
        .set({
          lastFetched: new Date(),
          fetchErrors: 0,
        })
        .where(eq(rssFeedSources.id, source.id));
    }

    logger.info(
      `RSS fetch complete: ${fetched} feeds fetched, ${stored} headlines stored, ${errors} errors`,
      { fetched, stored, errors },
      'RSSFeedService'
    );

    return { fetched, stored, errors };
  }

  /**
   * Get recent headlines that haven't been transformed into parodies yet
   * Only returns headlines from the last 7 days
   */
  async getUntransformedHeadlines(limit = 50): Promise<RSSHeadline[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get headlines without parody by checking if no parodyHeadline exists with matching originalHeadlineId
    const results = await db
      .select()
      .from(rssHeadlines)
      .where(
        and(
          gte(rssHeadlines.publishedAt, sevenDaysAgo),
          sql`NOT EXISTS (
            SELECT 1 FROM ${parodyHeadlines} 
            WHERE ${parodyHeadlines.originalHeadlineId} = ${rssHeadlines.id}
          )`
        )
      )
      .orderBy(desc(rssHeadlines.publishedAt))
      .limit(limit);

    return results;
  }

  /**
   * Clean up old headlines (older than 7 days)
   */
  async cleanupOldHeadlines(): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await db
      .delete(rssHeadlines)
      .where(lt(rssHeadlines.publishedAt, sevenDaysAgo))
      .returning({ id: rssHeadlines.id });

    const count = result.length;

    logger.info(
      `Cleaned up ${count} old RSS headlines`,
      { count },
      'RSSFeedService'
    );

    return count;
  }
}

// Singleton instance
export const rssFeedService = new RSSFeedService();
