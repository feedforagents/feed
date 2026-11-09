/**
 * MCP query_feed must return posts in the feed's total order
 * (timestamp desc, id desc) — the order the web feed query
 * (DatabaseService.getRecentPosts) uses for the same posts.
 *
 * executeQueryFeed ordered by timestamp alone, so posts sharing one
 * timestamp came back in storage order and the limit cut kept the
 * wrong end of a tied block: the posts the canonical order shows
 * first were the ones dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, db, inArray, posts, users } from '@feed/db';
import { executeQueryFeed } from '../../mcp/src/handlers/tool-handlers';

const agent = { agentId: 'agent', userId: 'f137-viewer' };
const AUTHOR = 'f137-order-author';

const ownedUsers: string[] = [AUTHOR];
const ownedPosts: string[] = [];

const NEWER = 'f137-order-newer';
const OLDER = 'f137-order-older';
const TIE_COUNT = 30;
const tieBase = 777_000_000_000_000_000n;
const tieIds: string[] = [];

async function createPost(id: string, timestamp: Date): Promise<void> {
  await db.insert(posts).values({
    id,
    content: `f137 order post ${id}`,
    authorId: AUTHOR,
    timestamp,
    createdAt: timestamp,
  });
  ownedPosts.push(id);
}

async function feedIds(limit: number): Promise<string[]> {
  const result = await executeQueryFeed(agent as never, { limit });
  return result.posts.map((p) => p.id);
}

describe('MCP query_feed total order', () => {
  beforeAll(async () => {
    await db.insert(users).values({
      id: AUTHOR,
      username: 'f137-order-author',
      isTest: false,
      isActor: false,
      updatedAt: new Date(),
    });

    const now = Date.now();
    await createPost(NEWER, new Date(now - 60_000));
    // 30 posts at one identical timestamp, inserted in ascending id
    // order so storage order is the opposite of the canonical order.
    const tieTimestamp = new Date(now - 120_000);
    for (let i = 1; i <= TIE_COUNT; i++) {
      const id = (tieBase + BigInt(i)).toString();
      tieIds.push(id);
      await createPost(id, tieTimestamp);
    }
    await createPost(OLDER, new Date(now - 3_600_000));
  });

  afterAll(async () => {
    await db.delete(posts).where(inArray(posts.id, ownedPosts));
    await db.delete(users).where(inArray(users.id, ownedUsers));
    await closeDatabase();
  });

  it('returns distinct timestamps newest-first and a tied block in id-descending order', async () => {
    const ids = (await feedIds(50)).filter((id) => ownedPosts.includes(id));
    const expected = [NEWER, ...[...tieIds].sort().reverse(), OLDER];
    expect(ids).toEqual(expected);
  });

  it('the limit cut keeps the id-descending head of a tied block', async () => {
    const ids = (await feedIds(11)).filter((id) => ownedPosts.includes(id));
    const expected = [NEWER, ...[...tieIds].sort().reverse().slice(0, 10)];
    expect(ids).toEqual(expected);
  });
});
