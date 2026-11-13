/**
 * MCP query_feed must apply the viewer's moderation policy.
 *
 * PRD §8.1: "Same business logic as the website. Tools call the same
 * services REST uses (notifications, repost posts, rate limits,
 * moderation), not raw DB writes." The website's post lists exclude
 * authors the viewer blocked or muted, and authors who blocked the
 * viewer (the shared @feed/db moderation sets); the shipped MCP
 * search_agents tool already applies the same three exclusions.
 * query_feed returned those authors' posts in every mode.
 *
 * Real DB, real executor (executeQueryFeed), two modes: the plain
 * feed and the questionId-scoped feed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  inArray,
  posts,
  questions,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeQueryFeed } from '../../mcp/src/handlers/tool-handlers';

const CALLER = 'f176-caller';
const STRANGER = 'f176-stranger';
const A_MAIN = 'f176-author-main';
const A_BLOCKED = 'f176-author-blocked';
const A_MUTED = 'f176-author-muted';
const A_BLOCKER = 'f176-author-blocker';

const Q_ID = 'f176-q-active';
const QN = 917601;

const T0 = new Date(Date.now() - 2 * 60 * 60 * 1000);
T0.setMilliseconds(0);
const MIN = 60 * 1000;

const ids: Record<string, string> = {};
const allPostIds: string[] = [];

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertPost(
  key: string,
  authorId: string,
  minutesAfterT0: number,
  opts: { relatedQuestion?: number; deletedAt?: Date } = {}
) {
  const id = await generateSnowflakeId();
  const ts = new Date(T0.getTime() + minutesAfterT0 * MIN);
  await db.insert(posts).values({
    id,
    content: `f176 post ${key}`,
    authorId,
    relatedQuestion: opts.relatedQuestion ?? null,
    timestamp: ts,
    createdAt: ts,
    deletedAt: opts.deletedAt ?? null,
  });
  ids[key] = id;
  allPostIds.push(id);
  return id;
}

beforeAll(async () => {
  await insertUser(CALLER);
  await insertUser(STRANGER);
  await insertUser(A_MAIN);
  await insertUser(A_BLOCKED);
  await insertUser(A_MUTED);
  await insertUser(A_BLOCKER);

  await db.insert(questions).values({
    id: Q_ID,
    questionNumber: QN,
    marketId: null,
    text: 'f176 question',
    scenarioId: 1,
    outcome: false,
    rank: 1,
    resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    status: 'active',
    updatedAt: new Date(),
  });

  // Caller moderation relationships
  await db.insert(userBlocks).values([
    {
      id: await generateSnowflakeId(),
      blockerId: CALLER,
      blockedId: A_BLOCKED,
    },
    {
      id: await generateSnowflakeId(),
      blockerId: A_BLOCKER,
      blockedId: CALLER,
    },
  ]);
  await db.insert(userMutes).values({
    id: await generateSnowflakeId(),
    muterId: CALLER,
    mutedId: A_MUTED,
  });

  // Plain-feed posts, one per axis
  await insertPost('main', A_MAIN, 1);
  await insertPost('own', CALLER, 2);
  await insertPost('blocked', A_BLOCKED, 3);
  await insertPost('muted', A_MUTED, 4);
  await insertPost('blocker', A_BLOCKER, 5);
  // Shipped-behaviour guards: deleted and future posts stay hidden.
  await insertPost('deleted', A_MAIN, 6, { deletedAt: new Date() });
  await insertPost('future', A_MAIN, 240);

  // Question-scoped posts, one per axis
  await insertPost('q-main', A_MAIN, 11, { relatedQuestion: QN });
  await insertPost('q-blocked', A_BLOCKED, 12, { relatedQuestion: QN });
  await insertPost('q-muted', A_MUTED, 13, { relatedQuestion: QN });
  await insertPost('q-blocker', A_BLOCKER, 14, { relatedQuestion: QN });
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db
    .delete(userBlocks)
    .where(inArray(userBlocks.blockerId, [CALLER, A_BLOCKER]));
  await db.delete(userMutes).where(inArray(userMutes.muterId, [CALLER]));
  await db.delete(questions).where(inArray(questions.id, [Q_ID]));
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        CALLER,
        STRANGER,
        A_MAIN,
        A_BLOCKED,
        A_MUTED,
        A_BLOCKER,
      ])
    );
});

async function feedIds(userId: string, args: Record<string, unknown> = {}) {
  const result = await executeQueryFeed(
    { agentId: 'f176-agent', userId } as never,
    { limit: 100, ...args } as never
  );
  return new Set(result.posts.map((p) => p.id));
}

describe('MCP query_feed viewer moderation', () => {
  it('hides blocked, muted and blocked-by authors in the plain feed', async () => {
    const got = await feedIds(CALLER);
    expect(got.has(ids.main)).toBe(true);
    expect(got.has(ids.own)).toBe(true);
    expect(got.has(ids.blocked)).toBe(false);
    expect(got.has(ids.muted)).toBe(false);
    expect(got.has(ids.blocker)).toBe(false);
    // Shipped guards unchanged
    expect(got.has(ids.deleted)).toBe(false);
    expect(got.has(ids.future)).toBe(false);
  });

  it('hides blocked, muted and blocked-by authors in the question feed', async () => {
    const got = await feedIds(CALLER, { questionId: Q_ID });
    expect(got.has(ids['q-main'])).toBe(true);
    expect(got.has(ids['q-blocked'])).toBe(false);
    expect(got.has(ids['q-muted'])).toBe(false);
    expect(got.has(ids['q-blocker'])).toBe(false);
  });

  it('shows every author to a viewer with no moderation relationships', async () => {
    const got = await feedIds(STRANGER);
    expect(got.has(ids.main)).toBe(true);
    expect(got.has(ids.blocked)).toBe(true);
    expect(got.has(ids.muted)).toBe(true);
    expect(got.has(ids.blocker)).toBe(true);
  });
});
