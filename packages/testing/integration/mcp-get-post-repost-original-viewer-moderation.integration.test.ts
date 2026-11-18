/**
 * MCP `get_post` (executeGetPost) must apply the viewer's moderation policy
 * to the original post embedded in a repost/quote.
 *
 * executeGetPost is a thin proxy: it fetches GET /api/posts/[id] anonymously
 * (no auth is forwarded — #1878's comment says so outright), so even after
 * the web route hides non-exposable originals for signed readers, the MCP
 * result still carries the full original. The handler therefore strips the
 * repost metadata itself, for the viewer who called it — the same rule the
 * web route, feed, stories, profile posts list (F15-01, #1940) and SSE
 * (F10-01) apply to embedded originals, and the same post-fetch pattern
 * #1878 uses for get_post's commentCount.
 *
 * This test calls the real handler, which fetches the real dev server
 * (http://localhost:3000, serving this worktree against feed_f39r3), against
 * the real database. No mocks.
 *
 * Run with the dev server up:
 *   redis-server --port 6379 --save '' --appendonly no
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_f39r3
 *   DIRECT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_f39r3
 *   DISABLE_RATE_LIMITING=true NODE_ENV=development bun x next dev -p 3000
 * Then:
 *   DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_f39r3
 *   DIRECT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/feed_f39r3
 *   TZ=UTC bun test integration/mcp-get-post-repost-original-viewer-moderation.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  closeDatabase,
  db,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetPost } from '../../mcp/src/handlers/tool-handlers';

type PostData = {
  id: string;
  content?: string | null;
  authorId?: string;
  isRepost?: boolean;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
  } | null;
};

function ownership() {
  return {
    users: new Set<string>(),
    posts: new Set<string>(),
    blocks: new Set<string>(),
    mutes: new Set<string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

let viewerId: string;
let otherViewerId: string;
let reposterId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockerAuthorId: string;
let okAuthorId: string;

let origBlockedId: string;
let origMutedId: string;
let origBlockerId: string;
let origOkId: string;
let repostBlockedId: string;
let repostMutedId: string;
let repostBlockerId: string;
let repostOkId: string;
let quoteBlockedId: string;
let viewerRepostBlockedId: string;

async function fetchPost(postId: string, userId: string) {
  const result = await executeGetPost({ agentId: 'agent', userId } as never, {
    postId,
  });
  const data = (result as unknown as { data: PostData }).data;
  return data;
}

async function cleanup(receipts: Ownership) {
  const actions = [
    {
      ids: receipts.blocks,
      remove: () =>
        db
          .delete(userBlocks)
          .where(inArray(userBlocks.id, [...receipts.blocks]))
          .returning({ id: userBlocks.id }),
    },
    {
      ids: receipts.mutes,
      remove: () =>
        db
          .delete(userMutes)
          .where(inArray(userMutes.id, [...receipts.mutes]))
          .returning({ id: userMutes.id }),
    },
    {
      ids: receipts.posts,
      remove: () =>
        db
          .delete(posts)
          .where(inArray(posts.id, [...receipts.posts]))
          .returning({ id: posts.id }),
    },
    {
      ids: receipts.users,
      remove: () =>
        db
          .delete(users)
          .where(inArray(users.id, [...receipts.users]))
          .returning({ id: users.id }),
    },
  ];
  const failures: Error[] = [];
  for (const { ids, remove } of actions) {
    if (ids.size === 0) continue;
    try {
      for (const row of await remove()) ids.delete(row.id);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (Object.values(receipts).some((ids) => ids.size > 0))
    failures.push(
      new Error('Owned MCP repost-original identities remain after cleanup')
    );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned MCP repost-original cleanup failed'
    );
}

beforeAll(async () => {
  [
    viewerId,
    otherViewerId,
    reposterId,
    blockedAuthorId,
    mutedAuthorId,
    blockerAuthorId,
    okAuthorId,
    origBlockedId,
    origMutedId,
    origBlockerId,
    origOkId,
    repostBlockedId,
    repostMutedId,
    repostBlockerId,
    repostOkId,
    quoteBlockedId,
    viewerRepostBlockedId,
  ] = await Promise.all(
    Array.from({ length: 17 }, () => generateSnowflakeId())
  );

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: viewerId,
        username: `f39mv-${viewerId}`,
        displayName: 'MCP Repost Original Viewer',
        updatedAt: now,
      },
      {
        id: otherViewerId,
        username: `f39mo-${otherViewerId}`,
        displayName: 'MCP Repost Original Other Viewer',
        updatedAt: now,
      },
      {
        id: reposterId,
        username: `f39mr-${reposterId}`,
        displayName: 'MCP Repost Original Reposter',
        updatedAt: now,
      },
      {
        id: blockedAuthorId,
        username: `f39mb-${blockedAuthorId}`,
        displayName: 'MCP Blocked Original Author',
        updatedAt: now,
      },
      {
        id: mutedAuthorId,
        username: `f39mm-${mutedAuthorId}`,
        displayName: 'MCP Muted Original Author',
        updatedAt: now,
      },
      {
        id: blockerAuthorId,
        username: `f39mk-${blockerAuthorId}`,
        displayName: 'MCP Blocking Original Author',
        updatedAt: now,
      },
      {
        id: okAuthorId,
        username: `f39mok-${okAuthorId}`,
        displayName: 'MCP Visible Original Author',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedOriginals = await db
    .insert(posts)
    .values([
      {
        id: origBlockedId,
        content: 'f39m-secret-blocked-original-content',
        authorId: blockedAuthorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: origMutedId,
        content: 'f39m-secret-muted-original-content',
        authorId: mutedAuthorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: origBlockerId,
        content: 'f39m-secret-blocker-original-content',
        authorId: blockerAuthorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: origOkId,
        content: 'f39m-visible-ok-original-content',
        authorId: okAuthorId,
        timestamp: earlier,
        createdAt: earlier,
      },
    ])
    .returning({ id: posts.id });
  for (const row of insertedOriginals) owned.posts.add(row.id);

  const insertedReposts = await db
    .insert(posts)
    .values([
      {
        id: repostBlockedId,
        content: '',
        authorId: reposterId,
        originalPostId: origBlockedId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: repostMutedId,
        content: '',
        authorId: reposterId,
        originalPostId: origMutedId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: repostBlockerId,
        content: '',
        authorId: reposterId,
        originalPostId: origBlockerId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: repostOkId,
        content: '',
        authorId: reposterId,
        originalPostId: origOkId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: quoteBlockedId,
        content: 'f39m-my-take-on-the-blocked-post',
        authorId: reposterId,
        originalPostId: origBlockedId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: viewerRepostBlockedId,
        content: '',
        authorId: viewerId,
        originalPostId: origBlockedId,
        timestamp: earlier,
        createdAt: earlier,
      },
    ])
    .returning({ id: posts.id });
  for (const row of insertedReposts) owned.posts.add(row.id);

  const [viewerBlockId, viewerBlockerBlockId, viewerMuteId] = await Promise.all(
    [generateSnowflakeId(), generateSnowflakeId(), generateSnowflakeId()]
  );
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: viewerBlockId, blockerId: viewerId, blockedId: blockedAuthorId },
      {
        id: viewerBlockerBlockId,
        blockerId: blockerAuthorId,
        blockedId: viewerId,
      },
    ])
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) owned.blocks.add(row.id);
  const insertedMutes = await db
    .insert(userMutes)
    .values({ id: viewerMuteId, muterId: viewerId, mutedId: mutedAuthorId })
    .returning({ id: userMutes.id });
  for (const row of insertedMutes) owned.mutes.add(row.id);
});

afterAll(async () => {
  await cleanup(owned);
  await closeDatabase();
});

describe('MCP get_post repost original viewer moderation', () => {
  it('hides the original of a simple repost by a blocked author', async () => {
    const data = await fetchPost(repostBlockedId, viewerId);
    expect(data.originalPost).toBeUndefined();
    expect(data.isRepost).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(
      'f39m-secret-blocked-original-content'
    );
  });

  it('hides the original of a simple repost by a muted author', async () => {
    const data = await fetchPost(repostMutedId, viewerId);
    expect(data.originalPost).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(
      'f39m-secret-muted-original-content'
    );
  });

  it('hides the original of a simple repost by an author who blocked the viewer', async () => {
    const data = await fetchPost(repostBlockerId, viewerId);
    expect(data.originalPost).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(
      'f39m-secret-blocker-original-content'
    );
  });

  it('hides the original of a quote of a blocked author but keeps the quote text', async () => {
    const data = await fetchPost(quoteBlockedId, viewerId);
    expect(data.content).toBe('f39m-my-take-on-the-blocked-post');
    expect(data.originalPost).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(
      'f39m-secret-blocked-original-content'
    );
  });

  it('hides the original even when the viewer is the reposter', async () => {
    const data = await fetchPost(viewerRepostBlockedId, viewerId);
    expect(data.originalPost).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(
      'f39m-secret-blocked-original-content'
    );
  });

  it('keeps the original of a repost by a visible author', async () => {
    const data = await fetchPost(repostOkId, viewerId);
    expect(data.isRepost).toBe(true);
    expect(data.originalPost?.id).toBe(origOkId);
    expect(data.originalPost?.content).toBe('f39m-visible-ok-original-content');
  });

  it('an unrelated viewer still sees the original', async () => {
    const data = await fetchPost(repostBlockedId, otherViewerId);
    expect(data.isRepost).toBe(true);
    expect(data.originalPost?.id).toBe(origBlockedId);
    expect(data.originalPost?.content).toBe(
      'f39m-secret-blocked-original-content'
    );
  });
});
