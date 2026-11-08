/**
 * GET /api/feed/narrative (home Stories feed) against a real database:
 * when the author of a post deletes it after someone quoted/reposted it,
 * the deleted post's content must not keep circulating inside the quote.
 *
 * Every sibling read path enforces this. The For You pipeline and the
 * stories pipeline fetch repost originals with isNull(posts.deletedAt)
 * under the comment "Deleted originals must not be rendered inside
 * reposts"; the post detail route filters the same way; the post list
 * and profile posts routes keep the quote but drop the deleted embed
 * (PostCard then renders its "This post has been deleted" tombstone).
 * The narrative route's original fetch had no such filter, so the full
 * text of a deleted post was embedded in the home-feed response.
 *
 * The route handler is exercised unmodified and anonymously; deletion
 * goes through the real DELETE /api/posts/[id] handler (dev-bypass auth,
 * same as production soft delete).
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// The only stub: the `server-only` marker package (an empty environment
// guard that throws outside a Server Component); every database and cache
// dependency runs for real. Same pattern as favorites-post-count.
mock.module('server-only', () => ({}));

import { invalidateCache } from '@feed/api';
import { db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const DELETED_BODY = 'F66 deleted original body';
const LIVE_BODY = 'F66 live original body';

type FeedPost = {
  id: string;
  content: string;
  isRepost?: boolean;
  isQuote?: boolean;
  originalPostId?: string | null;
  originalPost?: { id: string; content: string; authorId: string } | null;
};
type NarrativeBody = {
  success: boolean;
  stories: Array<{ storyKey: string; posts: FeedPost[] }>;
};

let authorA: string; // original author
let authorB: string; // quoter / reposter
let deletedOriginalId: string;
let quoteOfDeletedId: string;
let repostOfDeletedId: string;
let liveOriginalId: string;
let quoteOfLiveId: string;
const allPostIds: string[] = [];

let body: NarrativeBody;
let flatPosts: FeedPost[];

let narrativeGET: typeof import('../../../apps/web/src/app/api/feed/narrative/route').GET;
let postDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/route').DELETE;

function findPost(id: string): FeedPost | undefined {
  return flatPosts.find((p) => p.id === id);
}

beforeAll(async () => {
  ({ GET: narrativeGET } = await import(
    '../../../apps/web/src/app/api/feed/narrative/route'
  ));
  ({ DELETE: postDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  [authorA, authorB] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  [
    deletedOriginalId,
    quoteOfDeletedId,
    repostOfDeletedId,
    liveOriginalId,
    quoteOfLiveId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allPostIds.push(
    deletedOriginalId,
    quoteOfDeletedId,
    repostOfDeletedId,
    liveOriginalId,
    quoteOfLiveId
  );

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  await db.insert(users).values([
    {
      id: authorA,
      username: `test-f66-a-${authorA}`,
      displayName: 'F66 Original Author',
      updatedAt: new Date(now),
    },
    {
      id: authorB,
      username: `test-f66-b-${authorB}`,
      displayName: 'F66 Quoter',
      updatedAt: new Date(now),
    },
  ]);

  // Two originals by A; B quotes both and plainly reposts the first.
  // Narrative window is 12h, so all timestamps are a few hours old.
  await db.insert(posts).values([
    {
      id: deletedOriginalId,
      content: DELETED_BODY,
      authorId: authorA,
      timestamp: at(180),
      createdAt: at(180),
    },
    {
      id: liveOriginalId,
      content: LIVE_BODY,
      authorId: authorA,
      timestamp: at(170),
      createdAt: at(170),
    },
    {
      id: quoteOfDeletedId,
      content: 'F66 quote commentary',
      authorId: authorB,
      type: 'repost',
      originalPostId: deletedOriginalId,
      timestamp: at(120),
      createdAt: at(120),
    },
    {
      id: repostOfDeletedId,
      content: '',
      authorId: authorB,
      type: 'repost',
      originalPostId: deletedOriginalId,
      timestamp: at(60),
      createdAt: at(60),
    },
    {
      id: quoteOfLiveId,
      content: 'F66 live quote commentary',
      authorId: authorB,
      type: 'repost',
      originalPostId: liveOriginalId,
      timestamp: at(90),
      createdAt: at(90),
    },
  ]);

  // The original author deletes their post through the real route.
  const deleteRequest = new NextRequest(
    new Request(`http://localhost/api/posts/${deletedOriginalId}`, {
      method: 'DELETE',
      headers: { 'x-dev-user-id': authorA },
    })
  );
  const deleteResponse = await postDELETE(deleteRequest, {
    params: Promise.resolve({ id: deletedOriginalId }),
  });
  expect(deleteResponse.status).toBe(200);
  const [deletedRow] = await db
    .select({ deletedAt: posts.deletedAt })
    .from(posts)
    .where(eq(posts.id, deletedOriginalId));
  expect(deletedRow?.deletedAt).not.toBeNull();

  // The narrative feed is globally cached; drop any stale entry so the
  // handler recomputes from the database as it would after expiry.
  await invalidateCache('feed:narrative:v2');

  const request = new NextRequest(
    new Request('http://localhost/api/feed/narrative')
  );
  const response = await narrativeGET(request);
  expect(response.status).toBe(200);
  body = (await response.json()) as NarrativeBody;
  flatPosts = body.stories.flatMap((story) => story.posts);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(inArray(users.id, [authorA, authorB]));
  await invalidateCache('feed:narrative:v2');
});

describe('narrative feed quote embeds vs deleted originals', () => {
  it('keeps the quote post itself in the feed', () => {
    const quote = findPost(quoteOfDeletedId);
    expect(quote).toBeDefined();
    expect(quote?.content).toBe('F66 quote commentary');
  });

  it('does not embed a deleted original inside a quote post', () => {
    const quote = findPost(quoteOfDeletedId);
    expect(quote?.originalPost).toBeNull();
  });

  it('does not embed a deleted original inside a simple repost', () => {
    const repost = findPost(repostOfDeletedId);
    expect(repost).toBeDefined();
    expect(repost?.originalPost).toBeNull();
  });

  it('never leaks the deleted post body anywhere in the response', () => {
    expect(JSON.stringify(body)).not.toContain(DELETED_BODY);
  });

  it('does not list the deleted original as a top-level post', () => {
    expect(findPost(deletedOriginalId)).toBeUndefined();
  });

  it('still embeds a live original inside its quote post', () => {
    const quote = findPost(quoteOfLiveId);
    expect(quote).toBeDefined();
    expect(quote?.originalPost?.id).toBe(liveOriginalId);
    expect(quote?.originalPost?.content).toBe(LIVE_BODY);
  });
});
