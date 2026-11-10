/**
 * MCP query_feed must return posts in the feed's total order
 * (timestamp desc, id desc) — the order the web feed query
 * (DatabaseService.getRecentPosts) uses for the same posts.
 *
 * executeQueryFeed ordered by timestamp alone, so posts sharing one
 * timestamp came back in storage order and the limit cut kept the
 * wrong end of a tied block: the posts the canonical order shows
 * first were the ones dropped.
 *
 * Fixture ownership: every ID below is unique to the run
 * (snowflake-derived), the owned* arrays start empty, and an ID is
 * registered only from the RETURNING clause of the insert that
 * created it. A setup collision therefore registers nothing, and
 * teardown can only ever delete rows this file created — the
 * collision suite at the bottom proves a pre-existing row survives
 * both a failed setup and the cleanup. The preload disconnects the
 * shared client when the run drains, so this file does not close it.
 *
 * Isolation: all fixture posts carry one run-owned question number,
 * so the questionId window (an existing filter) contains exactly
 * this fixture; the order assertions run against that window with no
 * filtering, as well as against the plain feed filtered to owned IDs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  eq,
  inArray,
  posts,
  questions,
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '../../api/src/utils/api-keys';
import { MCPRequestHandler } from '../../mcp/src/handlers/mcp-request-handler';
import { executeQueryFeed } from '../../mcp/src/handlers/tool-handlers';
import type { AuthenticatedAgent } from '../../mcp/src/types/mcp';

const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  keys: [] as string[],
};

let authorId = '';
let viewerId = '';
let questionId = '';
let questionNumber = 0;
let viewerApiKey = '';

const TIE_COUNT = 30;
let newerPostId = '';
let olderPostId = '';
const tieIds: string[] = [];

async function insertOwnedUserInto(
  target: typeof owned,
  values: { id: string; username: string }
): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({ ...values, isTest: false, isActor: false, updatedAt: new Date() })
    .returning({ id: users.id });
  const row = inserted[0];
  assert.ok(row, 'user insert returned no row');
  target.users.push(row.id);
  return row.id;
}

async function insertOwnedUser(values: {
  id: string;
  username: string;
}): Promise<string> {
  return insertOwnedUserInto(owned, values);
}

async function insertOwnedPost(values: {
  id: string;
  authorId: string;
  timestamp: Date;
}): Promise<string> {
  const inserted = await db
    .insert(posts)
    .values({
      id: values.id,
      content: `f137 order post ${values.id}`,
      authorId: values.authorId,
      timestamp: values.timestamp,
      createdAt: values.timestamp,
      relatedQuestion: questionNumber,
    })
    .returning({ id: posts.id });
  const row = inserted[0];
  assert.ok(row, 'post insert returned no row');
  owned.posts.push(row.id);
  return row.id;
}

async function cleanupOwned(target: typeof owned): Promise<void> {
  if (target.keys.length > 0) {
    await db.delete(userApiKeys).where(inArray(userApiKeys.id, target.keys));
  }
  if (target.posts.length > 0) {
    await db.delete(posts).where(inArray(posts.id, target.posts));
  }
  if (target.questions.length > 0) {
    await db.delete(questions).where(inArray(questions.id, target.questions));
  }
  if (target.users.length > 0) {
    await db.delete(users).where(inArray(users.id, target.users));
  }
}

async function feedIds(args: {
  limit: number;
  questionId?: string;
}): Promise<string[]> {
  const agent: AuthenticatedAgent = { agentId: viewerId, userId: viewerId };
  const result = await executeQueryFeed(agent, args);
  return result.posts.map((p) => p.id);
}

const toolCallResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object({
    isError: z.literal(false),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  }),
});

describe('MCP query_feed total order', () => {
  beforeAll(async () => {
    authorId = await insertOwnedUser({
      id: await generateSnowflakeId(),
      username: `f137-author-${randomUUID().slice(0, 8)}`,
    });
    viewerId = await insertOwnedUser({
      id: await generateSnowflakeId(),
      username: `f137-viewer-${randomUUID().slice(0, 8)}`,
    });

    viewerApiKey = generateApiKey();
    const insertedKey = await db
      .insert(userApiKeys)
      .values({
        id: await generateSnowflakeId(),
        userId: viewerId,
        keyHash: hashApiKey(viewerApiKey),
        name: 'f137 query_feed order transport evidence',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: userApiKeys.id });
    const keyRow = insertedKey[0];
    assert.ok(keyRow, 'api key insert returned no row');
    owned.keys.push(keyRow.id);

    questionNumber =
      Number(BigInt(await generateSnowflakeId()) % 1_000_000_000n) + 1;
    const insertedQuestion = await db
      .insert(questions)
      .values({
        id: await generateSnowflakeId(),
        questionNumber,
        text: 'f137 query_feed order fixture question',
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .returning({ id: questions.id });
    const questionRow = insertedQuestion[0];
    assert.ok(questionRow, 'question insert returned no row');
    owned.questions.push(questionRow.id);
    questionId = questionRow.id;

    const now = Date.now();
    newerPostId = await insertOwnedPost({
      id: await generateSnowflakeId(),
      authorId,
      timestamp: new Date(now - 60_000),
    });
    // 30 posts at one identical timestamp, inserted in ascending id
    // order so storage order is the opposite of the canonical order.
    // All tie IDs share one snowflake-derived base, so they have the
    // same length and string order matches numeric order.
    const tieBase = BigInt(await generateSnowflakeId());
    const tieTimestamp = new Date(now - 120_000);
    for (let i = 1; i <= TIE_COUNT; i++) {
      const id = (tieBase + BigInt(i)).toString();
      tieIds.push(id);
      await insertOwnedPost({ id, authorId, timestamp: tieTimestamp });
    }
    olderPostId = await insertOwnedPost({
      id: await generateSnowflakeId(),
      authorId,
      timestamp: new Date(now - 3_600_000),
    });
  });

  afterAll(async () => {
    await cleanupOwned(owned);
  });

  const expectedOrder = () => [
    newerPostId,
    ...[...tieIds].sort().reverse(),
    olderPostId,
  ];

  it('returns distinct timestamps newest-first and a tied block in id-descending order', async () => {
    const ids = (await feedIds({ limit: 50 })).filter((id) =>
      owned.posts.includes(id)
    );
    expect(ids).toEqual(expectedOrder());
  });

  it('the limit cut keeps the id-descending head of a tied block', async () => {
    const ids = (await feedIds({ limit: 11 })).filter((id) =>
      owned.posts.includes(id)
    );
    expect(ids).toEqual(expectedOrder().slice(0, 11));
  });

  it('returns exactly the fixture, in total order, inside the question window', async () => {
    const ids = await feedIds({ limit: 50, questionId });
    expect(ids).toEqual(expectedOrder());
  });

  it('keeps the id-descending head of the tied block inside the question window', async () => {
    const ids = await feedIds({ limit: 11, questionId });
    expect(ids).toEqual(expectedOrder().slice(0, 11));
  });

  it('returns the same total order over the MCP JSON-RPC transport with a real API key', async () => {
    const handler = new MCPRequestHandler();
    const requestId = randomUUID();
    const response = await handler.handle(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: 'query_feed',
          arguments: { limit: 50, questionId },
        },
      },
      { apiKey: viewerApiKey }
    );
    const parsed = toolCallResponseSchema.parse(response);
    expect(parsed.id).toBe(requestId);
    const text = parsed.result.content[0]?.text;
    assert.ok(text, 'tool call returned no text content');
    const payload = z
      .object({ posts: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(text));
    expect(payload.posts.map((p) => p.id)).toEqual(expectedOrder());
  });

  it('rejects a tools/call with an unknown API key at the transport layer', async () => {
    const handler = new MCPRequestHandler();
    const response = await handler.handle(
      {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: {
          name: 'query_feed',
          arguments: { limit: 5, questionId },
        },
      },
      { apiKey: 'feed_unknown_key_for_f137_transport_negative' }
    );
    expect(response.error?.code).toBe(-32001);
    expect(response.result).toBeUndefined();
  });
});

describe('MCP query_feed fixture ownership under setup collision', () => {
  // Rows that simulate another owner's data. They are deliberately
  // kept out of every owned array the fixture helpers manage; this
  // suite removes them itself at the end.
  const foreign = { userId: '', postId: '' };

  beforeAll(async () => {
    foreign.userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: foreign.userId,
      username: 'f137-foreign-author',
      isTest: false,
      isActor: false,
      updatedAt: new Date(),
    });
    foreign.postId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: foreign.postId,
      content: 'f137 foreign post',
      authorId: foreign.userId,
      timestamp: new Date(),
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(posts).where(eq(posts.id, foreign.postId));
    await db.delete(users).where(eq(users.id, foreign.userId));
  });

  it('a colliding setup registers nothing and cleanup preserves pre-existing rows', async () => {
    const localOwned: typeof owned = {
      users: [],
      posts: [],
      questions: [],
      keys: [],
    };

    // A setup insert that collides with the pre-existing user fails,
    // and because ownership is registered only from RETURNING, the
    // failed insert leaves localOwned empty.
    let collisionFailed = false;
    try {
      await insertOwnedUserInto(localOwned, {
        id: foreign.userId,
        username: 'f137-collision-attempt',
      });
    } catch {
      collisionFailed = true;
    }
    expect(collisionFailed).toBe(true);
    expect(localOwned.users).toEqual([]);

    // A partial setup: one later insert succeeds and is registered.
    const partialUserId = await insertOwnedUserInto(localOwned, {
      id: await generateSnowflakeId(),
      username: 'f137-partial-setup-user',
    });
    expect(localOwned.users).toEqual([partialUserId]);

    await cleanupOwned(localOwned);

    // The row the partial setup actually created is gone...
    const partialRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, partialUserId));
    expect(partialRows).toEqual([]);

    // ...and the pre-existing rows were never touched.
    const foreignUser = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, foreign.userId));
    expect(foreignUser).toEqual([
      { id: foreign.userId, username: 'f137-foreign-author' },
    ]);
    const foreignPost = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, foreign.postId));
    expect(foreignPost).toEqual([{ id: foreign.postId }]);
  });
});
