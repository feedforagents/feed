// Invoked only in a fresh process by
// feed-story-author-eligibility.integration.test.ts.
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/(test_db|feed_pr\d+)$/);
assert.equal(process.env.DATABASE_READ_REPLICA_URL, '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

// This marker is the only module stub. Auth, PostgreSQL, candidate queries and
// getCacheOrFetch's memory backend/TTL all execute their production source.
mock.module('server-only', () => ({}));

const { closeDatabase, db, inArray, posts, questions, reactions, users } =
  await import('@feed/db');
const { NextRequest } = await import('next/server');
const { GET: narrativeGET } = await import(
  '../../../../apps/web/src/app/api/feed/narrative/route'
);
const { GET: forYouGET } = await import(
  '../../../../apps/web/src/app/api/feed/for-you/route'
);

const scenario = process.argv[2];
const runId = crypto.randomUUID();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  reactions: [] as string[],
};
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// A private future UTC day separates our query windows from concurrent normal
// integration data.
const now = new Date(Date.UTC(2041, 2, 10, 12, 0, 0));
setSystemTime(now);

const normal = crypto.randomUUID();
const flagged = crypto.randomUUID();
const prefix = `test-${crypto.randomUUID()}`;
const prefixWithoutUser = `test-${crypto.randomUUID()}`;
const likers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const seen = new Map<string, string>();

async function insertUsers(values: Array<typeof users.$inferInsert>) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  owned.users.push(...inserted.map((row) => row.id));
}

async function insertQuestion(): Promise<number> {
  const questionNumber =
    1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
  const id = crypto.randomUUID();
  await db.insert(questions).values({
    id,
    questionNumber,
    text: `Author eligibility ${runId}`,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    status: 'active',
    resolutionDate: new Date(now.getTime() + 7 * day),
    updatedAt: now,
    createdAt: new Date(now.getTime() - 8 * day),
    createdDate: new Date(now.getTime() - 8 * day),
  });
  owned.questions.push(id);
  return questionNumber;
}

async function addPost(
  label: string,
  authorId: string,
  ageHours: number,
  questionNumber: number | null,
  withLikes = false
) {
  const id = crypto.randomUUID();
  await db.insert(posts).values({
    id,
    authorId,
    content: `Author eligibility probe ${label} ${runId}`,
    timestamp: new Date(now.getTime() - ageHours * hour),
    createdAt: now,
    relatedQuestion: questionNumber,
  });
  owned.posts.push(id);
  seen.set(label, id);
  if (withLikes) {
    for (const liker of likers) {
      const rid = crypto.randomUUID();
      await db.insert(reactions).values({
        id: rid,
        userId: liker,
        postId: id,
        type: 'like',
        createdAt: now,
      });
      owned.reactions.push(rid);
    }
  }
}

type StoryShape = {
  stories: Array<{ posts: Array<{ id: string }> }>;
};

type NextRequestInstance = InstanceType<typeof NextRequest>;

async function readSurface(
  handler: (req: NextRequestInstance) => Promise<Response>,
  url: string
): Promise<string[]> {
  const response = await handler(new NextRequest(url));
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as StoryShape;
  return body.stories.flatMap((story) => story.posts.map((post) => post.id));
}

function assertVisibility(
  surface: string,
  ids: string[],
  visible: string[],
  hidden: string[]
) {
  for (const label of visible) {
    const id = seen.get(label);
    assert.ok(
      id && ids.includes(id),
      `${surface}: missing eligible fixture ${label}`
    );
  }
  for (const label of hidden) {
    const id = seen.get(label);
    assert.ok(
      id && !ids.includes(id),
      `${surface}: leaked test-author fixture ${label}`
    );
  }
}

const AUTHORS: Array<[string, string]> = [
  ['normal', normal],
  ['flagged', flagged],
  ['prefix', prefix],
  ['prefixnouser', prefixWithoutUser],
];
const TEST_LABELS = ['flagged', 'prefix', 'prefixnouser'];

try {
  await insertUsers([
    { id: normal, username: `normal-${runId}`, isTest: false, updatedAt: now },
    { id: flagged, username: `flag-${runId}`, isTest: true, updatedAt: now },
    { id: prefix, username: `prefix-${runId}`, isTest: false, updatedAt: now },
    ...likers.map((id) => ({
      id,
      username: `liker-${id.slice(0, 8)}-${runId}`,
      isTest: false,
      updatedAt: now,
    })),
  ]);

  if (scenario === 'recent') {
    // One question per author so every linked post leads its own story, plus
    // a liked standalone post per author for the general/spillover cards.
    for (const [label, authorId] of AUTHORS) {
      await addPost(`${label}-linked`, authorId, 1, await insertQuestion());
      await addPost(`${label}-solo`, authorId, 1, null, true);
    }
    const narrativeIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative'
    );
    assertVisibility(
      'narrative',
      narrativeIds,
      ['normal-linked', 'normal-solo'],
      TEST_LABELS.flatMap((label) => [`${label}-linked`, `${label}-solo`])
    );
    const forYouIds = await readSurface(
      forYouGET,
      'http://localhost/api/feed/for-you?limit=20'
    );
    assertVisibility(
      'for-you',
      forYouIds,
      ['normal-linked', 'normal-solo'],
      TEST_LABELS.flatMap((label) => [`${label}-linked`, `${label}-solo`])
    );
  } else if (scenario === 'backfill') {
    // 30h old: outside the For You 24h primary window, inside its 24h–14d
    // engagement-ranked backfill window.
    for (const [label, authorId] of AUTHORS) {
      await addPost(
        `${label}-linked`,
        authorId,
        30,
        await insertQuestion(),
        true
      );
    }
    const forYouIds = await readSurface(
      forYouGET,
      'http://localhost/api/feed/for-you?limit=20'
    );
    assertVisibility(
      'for-you-backfill',
      forYouIds,
      ['normal-linked'],
      TEST_LABELS.map((label) => `${label}-linked`)
    );
  } else if (scenario === 'discovery') {
    // 20d old standalone posts: inside the For You 14d–30d discovery window.
    for (const [label, authorId] of AUTHORS) {
      await addPost(`${label}-solo`, authorId, 20 * 24, null, true);
    }
    const forYouIds = await readSurface(
      forYouGET,
      'http://localhost/api/feed/for-you?limit=20'
    );
    assertVisibility(
      'for-you-discovery',
      forYouIds,
      ['normal-solo'],
      TEST_LABELS.map((label) => `${label}-solo`)
    );
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  try {
    if (owned.reactions.length)
      await db.delete(reactions).where(inArray(reactions.id, owned.reactions));
    if (owned.posts.length)
      await db.delete(posts).where(inArray(posts.id, owned.posts));
    if (owned.questions.length)
      await db.delete(questions).where(inArray(questions.id, owned.questions));
    if (owned.users.length)
      await db.delete(users).where(inArray(users.id, owned.users));
    for (const [table, ids] of [
      [posts, owned.posts],
      [questions, owned.questions],
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
console.log(
  `FEED_STORY_ELIGIBILITY_OK ${scenario} ${runId} owned rows cleaned`
);
process.exit(0);
