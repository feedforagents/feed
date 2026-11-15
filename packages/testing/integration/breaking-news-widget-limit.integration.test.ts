/**
 * The breaking-news widget documents a `limit` query parameter (OpenAPI
 * default 5, max 20) and the public RSS consumer at /feed/breaking-news/rss
 * asks for 20 items, but the route discarded the validated value and always
 * returned the configured three-item cap. Uses the real route and PostgreSQL.
 * Only the server-only environment marker is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, worldEvents } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/breaking-news/route';

const eventIds: string[] = [];
let newestEventId: string;

interface BreakingNewsResponse {
  success: boolean;
  news?: Array<{ id: string; title: string; timestamp: string }>;
}

beforeAll(async () => {
  // Five newsworthy public events, newest first. `announcement` matches the
  // helper's newsworthy patterns, and the timestamps sit ahead of any seeded
  // world event so the widget's top-five window contains exactly these rows.
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => generateSnowflakeId())
  );
  const now = Date.now();
  await db.insert(worldEvents).values(
    ids.map((id, index) => ({
      id,
      eventType: 'announcement',
      description: `Breaking news limit fixture ${index}`,
      visibility: 'public',
      gameId: 'continuous',
      timestamp: new Date(now - index * 1000),
      createdAt: new Date(now - index * 1000),
    }))
  );
  eventIds.push(...ids);
  newestEventId = ids[0]!;
});

afterAll(async () => {
  if (eventIds.length) {
    await db.delete(worldEvents).where(inArray(worldEvents.id, eventIds));
  }
});

async function requestNews(query = ''): Promise<{
  status: number;
  news: Array<{ id: string; title: string; timestamp: string }>;
}> {
  const response = await GET(
    new NextRequest(`http://localhost/api/feed/widgets/breaking-news${query}`)
  );
  const body = (await response.json()) as BreakingNewsResponse;
  return { status: response.status, news: body.news ?? [] };
}

describe('Breaking news widget honors the documented limit', () => {
  it('keeps the configured three-item cap when no limit is passed', async () => {
    const { status, news } = await requestNews();
    expect(status).toBe(200);
    expect(news).toHaveLength(3);
    expect(news[0]?.id).toBeDefined();
    expect(eventIds).toContain(news[0]!.id);
  });

  it('returns more than the widget cap when a larger limit is requested', async () => {
    const { status, news } = await requestNews('?limit=10');
    expect(status).toBe(200);
    // The base implementation always slices to three, so the fixture's five
    // events can never all appear until the validated limit is applied.
    expect(news.length).toBeGreaterThanOrEqual(5);
    for (const id of eventIds) {
      expect(news.some((item) => item.id === id)).toBe(true);
    }
  });

  it('returns a single item when limit=1', async () => {
    const { status, news } = await requestNews('?limit=1');
    expect(status).toBe(200);
    expect(news).toHaveLength(1);
    expect(news[0]?.id).toBe(newestEventId);
  });

  it('still rejects an out-of-range limit', async () => {
    const { status } = await requestNews('?limit=99');
    expect(status).toBe(400);
  });
});
