/**
 * Home stories (narrative) list composition, against a real database.
 *
 * GET /api/feed/narrative groups question-less ("general") posts into a
 * bucket that the route is supposed to dissolve into individual standalone
 * cards: at most MAX_STANDALONE_POSTS (20) of them, each competing on its
 * own score, and only those at or above MIN_STANDALONE_SCORE. Both sibling
 * pipelines that share this design — apps/web/src/app/api/feed/stories/
 * pipeline.ts and apps/web/src/app/api/feed/for-you/pipeline.ts — skip the
 * bucket in their story loop with the comment "General posts are emitted
 * below as standalone cards; grouping them into a 'General' mega-story as
 * well duplicated every one of them."
 *
 * The narrative route's story loop does not skip the bucket, so the payload
 * carries a '__general__' mega-story containing every general post AND the
 * standalone cards for the top 20 — every surfaced general post appears
 * twice, and the five posts that miss the standalone cut still appear
 * inside the mega-story, defeating the cap the dissolve was built to apply.
 *
 * The only stub is the `server-only` marker package; the route handler,
 * the cache layer and the database all run for real. The request is
 * anonymous, so no per-user enrichment is involved.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, inArray, posts, questions, reactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type NarrativeStoryShape = {
  storyKey: string;
  questionNumber: number | null;
  posts: Array<{ id: string }>;
};

type NarrativeResponse = {
  success: boolean;
  stories: NarrativeStoryShape[];
};

const QUESTION_NUMBER = 4242;
const GENERAL_COUNT = 25;
const STANDALONE_CAP = 20;

let authorId: string;
let questionId: string;
let questionPostId: string;
/** generalPostIds[i] receives i + 1 likes, so standalone rank is deterministic. */
const generalPostIds: string[] = [];
const reactorIds: string[] = [];

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/feed/narrative/route';

async function fetchNarrative() {
  const request = new NextRequest(
    new Request('http://localhost/api/feed/narrative')
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | NarrativeResponse
    | { data?: NarrativeResponse }
    | null;
  const payload = body && 'stories' in body ? body : (body?.data ?? null);
  return { status: response.status, payload };
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  authorId = await generateSnowflakeId();
  questionId = await generateSnowflakeId();
  questionPostId = await generateSnowflakeId();
  for (let i = 0; i < GENERAL_COUNT; i++) {
    generalPostIds.push(await generateSnowflakeId());
    reactorIds.push(await generateSnowflakeId());
  }

  await db.insert(users).values({
    id: authorId,
    username: `f83-author-${authorId}`,
    displayName: 'F83 Narrative Author',
    updatedAt: now,
  });

  await db.insert(questions).values({
    id: questionId,
    questionNumber: QUESTION_NUMBER,
    text: 'F83 fixture question',
    scenarioId: 1,
    outcome: false,
    rank: 1,
    resolutionDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    status: 'active',
    createdAt: threeDaysAgo,
    updatedAt: now,
  });

  await db.insert(posts).values({
    id: questionPostId,
    content: 'f83 question-linked post',
    authorId,
    timestamp: thirtyMinAgo,
    createdAt: thirtyMinAgo,
    relatedQuestion: QUESTION_NUMBER,
  });

  await db.insert(posts).values(
    generalPostIds.map((id, i) => ({
      id,
      content: `f83 general post ${i + 1}`,
      authorId,
      timestamp: oneHourAgo,
      createdAt: oneHourAgo,
      relatedQuestion: null,
    }))
  );

  // Likes: generalPostIds[i] gets i + 1 likes from distinct reactors, so
  // standalone scores rank strictly by index (same timestamp for all).
  const reactionRows: Array<{
    id: string;
    postId: string;
    userId: string;
    type: string;
  }> = [];
  for (let i = 0; i < GENERAL_COUNT; i++) {
    for (let r = 0; r <= i; r++) {
      reactionRows.push({
        id: await generateSnowflakeId(),
        postId: generalPostIds[i]!,
        userId: reactorIds[r]!,
        type: 'like',
      });
    }
  }
  await db.insert(reactions).values(reactionRows);
});

afterAll(async () => {
  await db
    .delete(reactions)
    .where(inArray(reactions.postId, [...generalPostIds, questionPostId]));
  await db
    .delete(posts)
    .where(inArray(posts.id, [...generalPostIds, questionPostId]));
  await db.delete(questions).where(eq(questions.id, questionId));
  await db.delete(users).where(eq(users.id, authorId));
});

describe('GET /api/feed/narrative — general post composition', () => {
  it('emits each general post at most once, as a standalone card, capped at 20', async () => {
    const { status, payload } = await fetchNarrative();
    expect(status).toBe(200);
    expect(payload).not.toBeNull();
    const stories = payload!.stories;

    // No mega-story grouping the general bucket a second time.
    expect(stories.map((s) => s.storyKey)).not.toContain('__general__');

    // Count every appearance of every fixture post across all stories.
    const appearances = new Map<string, number>();
    for (const story of stories) {
      for (const post of story.posts) {
        appearances.set(post.id, (appearances.get(post.id) ?? 0) + 1);
      }
    }

    // The question-linked post rides its question story exactly once.
    expect(appearances.get(questionPostId)).toBe(1);
    const questionStory = stories.find(
      (s) => s.storyKey === String(QUESTION_NUMBER)
    );
    expect(questionStory).toBeDefined();
    expect(questionStory!.posts.map((p) => p.id)).toEqual([questionPostId]);

    // Standalone cards: exactly the cap, one per top-ranked general post.
    const standalone = stories.filter((s) => s.storyKey.startsWith('post:'));
    expect(standalone).toHaveLength(STANDALONE_CAP);

    // generalPostIds[i] has i + 1 likes: ranks 6..25 likes make the cut,
    // ranks 1..5 likes must not appear anywhere in the payload.
    for (let i = 0; i < GENERAL_COUNT; i++) {
      const expected = i + 1 > GENERAL_COUNT - STANDALONE_CAP ? 1 : 0;
      expect(appearances.get(generalPostIds[i]!) ?? 0).toBe(expected);
    }
  });
});
