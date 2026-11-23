/** Retained public post detail and signed viewer moderation (PRD §§6.1/12). */
import { afterAll, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  simple: 'a signed viewer gets an empty shell for an excluded repost original',
  quote: 'a signed viewer keeps quote commentary when the original is excluded',
  visible: 'a signed viewer still sees an eligible repost original',
  public: 'a signed-out reader still sees the public repost original',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks post detail moderation in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-detail-repost-original-moderation',
      file: 'packages/testing/integration/post-detail-repost-original-moderation.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { db, posts, userBlocks, users } = await import('@feed/db');
  const { GET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );
  const owner = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const excluded = crypto.randomUUID();
  const visible = crypto.randomUUID();
  const excludedPost = crypto.randomUUID();
  const visiblePost = crypto.randomUUID();
  const simple = crypto.randomUUID();
  const quote = crypto.randomUUID();
  const normal = crypto.randomUUID();
  const viewerClaim = `repost-detail-${viewer}`;
  const token = await createStewardTestToken(viewerClaim);
  const excludedText = 'Excluded original fixture';
  const visibleText = 'Visible original fixture';
  const quoteText = 'Quote commentary fixture';
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [owner, viewer, excluded, visible].map((id) => ({
        id,
        username: `repost-detail-${id}`,
        displayName: `Repost fixture ${id.slice(0, 8)}`,
        stewardId: id === viewer ? viewerClaim : null,
        updatedAt: now,
      }))
    );
    await tx.insert(posts).values(
      [
        { id: excludedPost, authorId: excluded, content: excludedText },
        { id: visiblePost, authorId: visible, content: visibleText },
        {
          id: simple,
          authorId: owner,
          originalPostId: excludedPost,
          content: '',
        },
        {
          id: quote,
          authorId: owner,
          originalPostId: excludedPost,
          content: quoteText,
        },
        {
          id: normal,
          authorId: owner,
          originalPostId: visiblePost,
          content: '',
        },
      ].map((post) => ({ ...post, timestamp: now, createdAt: now }))
    );
    await tx.insert(userBlocks).values({
      id: crypto.randomUUID(),
      blockerId: viewer,
      blockedId: excluded,
    });
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const id = new URL(request.url).pathname.match(
        /^\/api\/posts\/([^/]+)$/
      )?.[1];
      return id && request.method === 'GET'
        ? GET(new NextRequest(request), { params: Promise.resolve({ id }) })
        : new Response(null, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  async function post(postId: string, signed = true) {
    const requestId = crypto.randomUUID();
    const response = await fetch(new URL(`/api/posts/${postId}`, server.url), {
      headers: {
        'x-request-id': requestId,
        ...(signed ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    expect(response.status).toBe(200);
    type Detail = {
      content?: string | null;
      isRepost?: boolean;
      originalPost?: { authorId: string; content: string };
    };
    const payload = (await response.json()) as { data?: Detail } & Detail;
    const detail = payload.data ?? payload;
    console.info('Repost detail response', {
      requestId,
      postId,
      signed,
      status: response.status,
      hasOriginal: !!detail.originalPost,
    });
    return detail;
  }

  test(cases.simple, async () => {
    const detail = await post(simple);
    expect(detail.content).toBe('');
    expect(detail.originalPost).toBeUndefined();
    expect(detail.isRepost).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(excludedText);
  });

  test(cases.quote, async () => {
    const detail = await post(quote);
    expect(detail.content).toBe(quoteText);
    expect(detail.originalPost).toBeUndefined();
    expect(detail.isRepost).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(excludedText);
  });

  test(cases.visible, async () => {
    const detail = await post(normal);
    expect(detail.isRepost).toBe(true);
    expect(detail.originalPost).toMatchObject({
      authorId: visible,
      content: visibleText,
    });
  });

  test(cases.public, async () => {
    const detail = await post(simple, false);
    expect(detail.isRepost).toBe(true);
    expect(detail.originalPost).toMatchObject({
      authorId: excluded,
      content: excludedText,
    });
  });
}
