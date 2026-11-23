/**
 * RSS Feed Service Unit Tests
 *
 * These are true unit tests that test RSS parsing logic without database access.
 * For database integration tests, see tests/integration/
 */

import { describe, expect, test } from 'bun:test';
import { rssFeedService } from '@feed/engine';

describe('RSSFeedService', () => {
  test('should parse RSS 2.0 format', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Test Item 1</title>
      <link>https://example.com/item1</link>
      <pubDate>Wed, 13 Nov 2024 12:00:00 GMT</pubDate>
      <description>Test description</description>
    </item>
    <item>
      <title>Test Item 2</title>
      <link>https://example.com/item2</link>
    </item>
  </channel>
</rss>`;

    // Mock fetch for this test
    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: true,
        text: async () => rssXml,
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const feed = await rssFeedService.fetchFeed(
        'https://example.com/test.xml'
      );

      expect(feed).toBeDefined();
      expect(feed.title).toBe('Test Feed');
      expect(feed.items).toHaveLength(2);
      expect(feed.items[0]?.title).toBe('Test Item 1');
      expect(feed.items[0]?.link).toBe('https://example.com/item1');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should handle fetch errors gracefully', async () => {
    // Mock fetch to fail
    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        rssFeedService.fetchFeed('https://example.com/nonexistent.xml')
      ).rejects.toThrow();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should parse Atom feeds with attributed text elements, multiple links, and updated fallback', async () => {
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">The Verge</title>
  <entry>
    <title type="html"><![CDATA[Kodak launches a tiny digital photo frame]]></title>
    <link rel="enclosure" type="image/jpeg" href="https://cdn.example.com/thumb.jpg" />
    <link rel="alternate" type="text/html" href="https://www.theverge.com/tech/1038650/kodak" />
    <id>https://www.theverge.com/?p=1038650</id>
    <published>2026-11-22T22:00:00-05:00</published>
    <summary type="html"><![CDATA[A tiny digital photo frame with tracker support.]]></summary>
    <content type="html">
      <![CDATA[<p>Full story body here.</p>]]>
    </content>
  </entry>
  <entry>
    <title type="text">Atom entry using updated timestamp only</title>
    <link href="https://example.com/atom-default-rel" />
    <id>tag:example.com,2026:2</id>
    <updated>2026-11-23T01:00:00Z</updated>
  </entry>
  <entry>
    <title>Plain Atom entry with non-alternate link fallback</title>
    <link rel="related" href="https://example.com/related-only" />
    <id>tag:example.com,2026:3</id>
    <published>2026-11-23T02:00:00Z</published>
  </entry>
</feed>`;

    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: true,
        text: async () => atomXml,
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const feed = await rssFeedService.fetchFeed(
        'https://www.theverge.com/rss/index.xml',
        1
      );

      expect(feed.title).toBe('The Verge');
      expect(feed.items).toHaveLength(3);
      expect(feed.items[0]).toEqual({
        title: 'Kodak launches a tiny digital photo frame',
        link: 'https://www.theverge.com/tech/1038650/kodak',
        pubDate: '2026-11-22T22:00:00-05:00',
        description: 'A tiny digital photo frame with tracker support.',
        content: '<p>Full story body here.</p>',
        guid: 'https://www.theverge.com/?p=1038650',
      });
      expect(feed.items[1]).toEqual({
        title: 'Atom entry using updated timestamp only',
        link: 'https://example.com/atom-default-rel',
        pubDate: '2026-11-23T01:00:00Z',
        description: undefined,
        content: undefined,
        guid: 'tag:example.com,2026:2',
      });
      expect(feed.items[2]?.link).toBe('https://example.com/related-only');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('should unwrap attributed elements in RSS 2.0 feeds', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title xml:lang="en">Attributed RSS Feed</title>
    <item>
      <title type="text">RSS headline with attribute</title>
      <link>https://example.com/rss-attr</link>
      <description type="html">Summary text with attribute</description>
      <guid isPermaLink="false">rss-guid-42</guid>
    </item>
  </channel>
</rss>`;

    const originalFetch = global.fetch;
    const mockFetch = async () =>
      ({
        ok: true,
        text: async () => rssXml,
      }) as Response;
    (mockFetch as unknown as typeof fetch).preconnect = fetch.preconnect;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const feed = await rssFeedService.fetchFeed(
        'https://example.com/rss-attr.xml',
        1
      );

      expect(feed.title).toBe('Attributed RSS Feed');
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0]).toEqual({
        title: 'RSS headline with attribute',
        link: 'https://example.com/rss-attr',
        pubDate: undefined,
        description: 'Summary text with attribute',
        content: undefined,
        guid: 'rss-guid-42',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('service should be defined with expected methods', () => {
    expect(rssFeedService).toBeDefined();
    expect(typeof rssFeedService.fetchFeed).toBe('function');
  });
});
