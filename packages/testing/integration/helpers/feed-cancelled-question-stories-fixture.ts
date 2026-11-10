// Invoked only in a fresh process by
// feed-cancelled-question-stories.integration.test.ts.
/** PRD §§6.1, 12 / MVP Phase 5: closed questions leave story surfaces. */
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/(test_db|feed_test_f159|feed_pr\d+)$/);
assert.equal(process.env.DATABASE_READ_REPLICA_URL, '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');
assert.equal(process.env.DISABLE_RATE_LIMITING, 'true');

// This marker is the only module stub. Auth, PostgreSQL, candidate queries and
// getCacheOrFetch's memory backend/TTL all execute their production source.
mock.module('server-only', () => ({}));

const {
  closeDatabase,
  db,
  inArray,
  markets,
  posts,
  questions,
  reactions,
  users,
} = await import('@feed/db');
const { NextRequest } = await import('next/server');
const { GET: forYouGET } = await import(
  '../../../../apps/web/src/app/api/feed/for-you/route'
);
const { GET: narrativeGET } = await import(
  '../../../../apps/web/src/app/api/feed/narrative/route'
);

const scenario = process.argv[2];
assert.ok(
  scenario === 'for-you' || scenario === 'narrative' || scenario === 'spill'
);
const spill = scenario === 'spill';
const runId = crypto.randomUUID();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  markets: [] as string[],
  reactions: [] as string[],
};
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// A private future UTC day separates our query windows from any concurrent
// integration data on a shared database.
const now = new Date(
  Date.UTC(2040, 0, 1) +
    (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000) * day +
    12 * hour
);
setSystemTime(now);

const author = crypto.randomUUID();
const questionBase =
  1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
const specs = [
  { key: 'active', status: 'active', resolutionOffsetDays: 7 },
  { key: 'cancelled', status: 'cancelled', resolutionOffsetDays: 7 },
  { key: 'resolved', status: 'resolved', resolutionOffsetDays: 7 },
  { key: 'expired', status: 'active', resolutionOffsetDays: -1 },
] as const;
const questionNumberByKey = new Map<string, number>();
const postIdsByKey = new Map<string, string[]>();

interface FeedStory {
  storyKey: string;
  questionNumber: number | null;
  postCount: number;
  marketId?: string | null;
  posts: Array<{ id: string }>;
}

async function readStories(): Promise<FeedStory[]> {
  const response =
    scenario === 'narrative'
      ? await narrativeGET(
          new NextRequest('http://localhost/api/feed/narrative')
        )
      : await forYouGET(
          new NextRequest('http://localhost/api/feed/for-you?limit=20')
        );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { stories: FeedStory[] };
  return body.stories;
}

try {
  await db
    .insert(users)
    .values({
      id: author,
      username: `f159-${runId}`,
      isTest: false,
      updatedAt: now,
    })
    .returning({ id: users.id })
    .then((rows) => owned.users.push(...rows.map((r) => r.id)));

  for (const [index, spec] of specs.entries()) {
    const questionNumber = questionBase + index;
    questionNumberByKey.set(spec.key, questionNumber);
    const marketId = crypto.randomUUID();
    const resolutionDate = new Date(
      now.getTime() + spec.resolutionOffsetDays * day
    );
    await db
      .insert(markets)
      .values({
        id: marketId,
        question: `F159 ${spec.key} market ${runId}`,
        liquidity: '1000',
        endDate: resolutionDate,
        createdAt: new Date(now.getTime() - 8 * day),
        updatedAt: now,
      })
      .returning({ id: markets.id })
      .then((rows) => owned.markets.push(...rows.map((r) => r.id)));
    await db
      .insert(questions)
      .values({
        id: crypto.randomUUID(),
        questionNumber,
        marketId,
        text: `F159 ${spec.key} question ${runId}`,
        scenarioId: 1,
        outcome: false,
        rank: 1,
        status: spec.status,
        resolutionDate,
        createdAt: new Date(now.getTime() - 8 * day),
        createdDate: new Date(now.getTime() - 8 * day),
        updatedAt: now,
      })
      .returning({ id: questions.id })
      .then((rows) => owned.questions.push(...rows.map((r) => r.id)));

    const ids: string[] = [];
    for (const ageHours of [1, 2]) {
      const id = crypto.randomUUID();
      await db
        .insert(posts)
        .values({
          id,
          authorId: author,
          content: `F159 ${spec.key} post ${ageHours}h ${runId}`,
          timestamp: new Date(now.getTime() - ageHours * hour),
          createdAt: now,
          relatedQuestion: questionNumber,
        })
        .returning({ id: posts.id })
        .then((rows) => owned.posts.push(...rows.map((r) => r.id)));
      ids.push(id);
    }
    postIdsByKey.set(spec.key, ids);
  }

  if (spill) {
    // For You promotes secondary posts of a question bucket as standalone
    // cards once their engagement reaches 3. Give the closed questions'
    // posts a clear lead (5 likes) and a promotable secondary (3 likes).
    const likers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      likers.push(id);
      await db
        .insert(users)
        .values({ id, username: `f159-liker-${i}-${runId}`, updatedAt: now })
        .returning({ id: users.id })
        .then((rows) => owned.users.push(...rows.map((r) => r.id)));
    }
    for (const key of ['cancelled', 'resolved'] as const) {
      const [lead, secondary] = postIdsByKey.get(key)!;
      for (const [postId, count] of [
        [lead, 5],
        [secondary, 3],
      ] as const) {
        for (let i = 0; i < count; i++) {
          await db
            .insert(reactions)
            .values({
              id: crypto.randomUUID(),
              postId,
              userId: likers[i]!,
              type: 'like',
              createdAt: now,
            })
            .returning({ id: reactions.id })
            .then((rows) => owned.reactions.push(...rows.map((r) => r.id)));
        }
      }
    }
  }

  const stories = await readStories();
  // Question stories carry storyKey === String(questionNumber). Market cards
  // (storyKey 'market-card:N' / 'resolved-market:N') are separate surfaces
  // with their own status enumerations and are not judged here.
  const storyByQuestion = new Map(
    stories
      .filter(
        (s) =>
          s.questionNumber !== null && s.storyKey === String(s.questionNumber)
      )
      .map((s) => [s.questionNumber as number, s])
  );
  const allPostIds = stories.flatMap((s) => s.posts.map((p) => p.id));
  const cancelledStory = storyByQuestion.get(
    questionNumberByKey.get('cancelled')!
  );
  console.log(
    `F159_MEASURE ${scenario} stories=${stories.length} ` +
      `cancelledPresent=${cancelledStory !== undefined} ` +
      `cancelledPostCount=${cancelledStory?.postCount ?? 0} ` +
      `cancelledMarketId=${cancelledStory?.marketId ?? 'none'} ` +
      `cancelledPostsVisible=${(postIdsByKey.get('cancelled') ?? []).filter((id) => allPostIds.includes(id)).length}`
  );

  // Guards: the live question's story is served, and the two closed states
  // the assembly already enumerates stay out — before and after any fix.
  const activeStory = storyByQuestion.get(questionNumberByKey.get('active')!);
  assert.ok(activeStory, 'active question story must be present');
  assert.equal(activeStory.postCount, 2);
  assert.equal(
    storyByQuestion.get(questionNumberByKey.get('resolved')!),
    undefined,
    'resolved question story must stay hidden'
  );
  assert.equal(
    storyByQuestion.get(questionNumberByKey.get('expired')!),
    undefined,
    'past-deadline question story must stay hidden'
  );

  // The defect: a question an admin voided (status 'cancelled', every
  // position refunded) must not be served as a live story either.
  assert.equal(
    cancelledStory,
    undefined,
    'cancelled question story must not be exposed'
  );
  for (const id of postIdsByKey.get('cancelled') ?? []) {
    assert.ok(
      !allPostIds.includes(id),
      'cancelled question post must not appear in any story card'
    );
  }

  if (spill) {
    // The spillover door: secondary posts of closed questions must not be
    // promoted as standalone cards either — for the voided question or for
    // the resolved one whose story the assembly already skips.
    const spilled = stories
      .filter((s) => s.storyKey.startsWith('post:'))
      .flatMap((s) => s.posts.map((p) => p.id));
    console.log(
      `F159_MEASURE spill cards=${spilled.length} ` +
        `cancelledSpilled=${(postIdsByKey.get('cancelled') ?? []).filter((id) => spilled.includes(id)).length} ` +
        `resolvedSpilled=${(postIdsByKey.get('resolved') ?? []).filter((id) => spilled.includes(id)).length}`
    );
    for (const key of ['cancelled', 'resolved'] as const) {
      for (const id of postIdsByKey.get(key) ?? []) {
        assert.ok(
          !spilled.includes(id),
          `${key} question post must not be promoted as a standalone card`
        );
      }
    }
  }
} finally {
  try {
    if (owned.reactions.length)
      await db.delete(reactions).where(inArray(reactions.id, owned.reactions));
    if (owned.posts.length)
      await db.delete(posts).where(inArray(posts.id, owned.posts));
    if (owned.questions.length)
      await db.delete(questions).where(inArray(questions.id, owned.questions));
    if (owned.markets.length)
      await db.delete(markets).where(inArray(markets.id, owned.markets));
    if (owned.users.length)
      await db.delete(users).where(inArray(users.id, owned.users));
    for (const [table, ids] of [
      [posts, owned.posts],
      [questions, owned.questions],
      [markets, owned.markets],
      [users, owned.users],
    ] as const) {
      if (ids.length)
        assert.equal(
          (
            await db
              .select({ id: table.id })
              .from(table)
              .where(inArray(table.id, ids))
          ).length,
          0
        );
    }
  } finally {
    setSystemTime();
    await closeDatabase();
  }
}
console.log(`F159_FIXTURE_OK ${scenario} ${runId} owned rows cleaned`);
process.exit(0);
