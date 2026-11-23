// Invoked only in a fresh process by stories-question-status.integration.test.ts.
// Verifies that the stories feed drops stories for questions that are no
// longer live (resolved, cancelled, or past their resolution date) and that
// per-viewer block/mute filtering holds on the same surface.
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/(test_db|feed_pr\d+)$/);
assert.equal(process.env.DATABASE_READ_REPLICA_URL, '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

mock.module('server-only', () => ({}));

const {
  closeDatabase,
  dailyTopics,
  db,
  eq,
  inArray,
  posts,
  questions,
  userBlocks,
  userMutes,
  users,
} = await import('@feed/db');
const { NextRequest } = await import('next/server');
const { GET } = await import(
  '../../../../apps/web/src/app/api/feed/stories/route'
);
const { createStewardTestToken } = await import('./steward-auth');

const scenario = process.argv[2];
const runId = crypto.randomUUID();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  topics: [] as string[],
  blocks: [] as string[],
  mutes: [] as string[],
};
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// A private future UTC day separates our query windows from any other data.
let now = new Date(
  Date.UTC(2040, 0, 1) +
    (crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000) * day +
    12 * hour
);
let topicDate = new Date(now);
topicDate.setUTCHours(0, 0, 0, 0);
while (
  (
    await db
      .select({ id: dailyTopics.id })
      .from(dailyTopics)
      .where(eq(dailyTopics.date, topicDate))
  ).length
) {
  now = new Date(now.getTime() + day);
  topicDate = new Date(topicDate.getTime() + day);
}
setSystemTime(now);

const topicKey = `stories-status-${runId}`;

function nextQuestionNumber() {
  return 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
}

async function insertUser(label: string, stewardId?: string) {
  const id = crypto.randomUUID();
  await db
    .insert(users)
    .values({
      id,
      username: `${label}-${runId}`,
      isTest: false,
      updatedAt: now,
      ...(stewardId ? { stewardId } : {}),
    })
    .returning({ id: users.id });
  owned.users.push(id);
  return id;
}

async function insertQuestion(
  status: string,
  resolutionOffsetDays: number
): Promise<number> {
  const questionNumber = nextQuestionNumber();
  const id = crypto.randomUUID();
  await db.insert(questions).values({
    id,
    questionNumber,
    text: `Stories status fixture ${status} ${runId}`,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    status,
    topicKey,
    resolutionDate: new Date(now.getTime() + resolutionOffsetDays * day),
    updatedAt: now,
    createdAt: new Date(now.getTime() - 8 * day),
    createdDate: new Date(now.getTime() - 8 * day),
  });
  owned.questions.push(id);
  return questionNumber;
}

async function addPost(authorId: string, questionNumber: number | null) {
  const id = crypto.randomUUID();
  await db.insert(posts).values({
    id,
    authorId,
    content: `Stories status fixture post ${runId} ${id}`,
    timestamp: new Date(now.getTime() - hour),
    createdAt: now,
    relatedQuestion: questionNumber,
  });
  owned.posts.push(id);
  return id;
}

interface StoryShape {
  storyKey: string;
  posts: Array<{ id: string; authorId: string }>;
}

async function readStories(headers: Record<string, string> = {}) {
  const response = await GET(
    new NextRequest('http://localhost/api/feed/stories?limit=20', { headers })
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as {
    topic: { topicKey: string } | null;
    stories: StoryShape[];
  };
  assert.equal(body.topic?.topicKey, topicKey);
  return body.stories;
}

function storyByKey(stories: StoryShape[], key: string) {
  return stories.find((s) => s.storyKey === key);
}

try {
  const topic = await db
    .insert(dailyTopics)
    .values({
      id: crypto.randomUUID(),
      date: topicDate,
      topicKey,
      topicLabel: 'Stories status fixture',
      summary: 'Fixture topic',
      sourceType: 'manual_override',
      sourceHeadlineIds: [],
      updatedAt: now,
    })
    .returning({ id: dailyTopics.id });
  owned.topics.push(...topic.map((row) => row.id));

  if (scenario === 'statuses') {
    const authorA = await insertUser('author-a');
    const authorB = await insertUser('author-b');

    const qActive = await insertQuestion('active', 7);
    const qCancelled = await insertQuestion('cancelled', 7);
    const qResolved = await insertQuestion('resolved', 7);
    const qOverdue = await insertQuestion('active', -1);

    const activePost = await addPost(authorA, qActive);
    await addPost(authorA, qCancelled);
    await addPost(authorB, qCancelled);
    await addPost(authorA, qResolved);
    await addPost(authorA, qOverdue);

    const stories = await readStories();

    const active = storyByKey(stories, String(qActive));
    assert.ok(active, 'active question story must be present');
    assert.ok(
      active.posts.some((p) => p.id === activePost),
      'active story must contain its post'
    );
    assert.equal(
      storyByKey(stories, String(qCancelled)),
      undefined,
      'cancelled (admin-voided) question story must not be present'
    );
    assert.equal(
      storyByKey(stories, String(qResolved)),
      undefined,
      'resolved question story must not be present'
    );
    assert.equal(
      storyByKey(stories, String(qOverdue)),
      undefined,
      'past-resolution question story must not be present'
    );
  } else if (scenario === 'moderation') {
    const viewerStewardId = `steward-${runId}`;
    const viewer = await insertUser('viewer', viewerStewardId);
    const viewerToken = await createStewardTestToken(viewerStewardId);
    const authorA = await insertUser('mod-author-a');
    const authorB = await insertUser('mod-author-b');
    const authorM = await insertUser('mod-author-m');

    const blockId = crypto.randomUUID();
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: viewer,
      blockedId: authorB,
    });
    owned.blocks.push(blockId);
    const muteId = crypto.randomUUID();
    await db.insert(userMutes).values({
      id: muteId,
      muterId: viewer,
      mutedId: authorM,
    });
    owned.mutes.push(muteId);

    const qMix = await insertQuestion('active', 7);
    const qOnlyBlocked = await insertQuestion('active', 7);
    const mixPostA = await addPost(authorA, qMix);
    await addPost(authorB, qMix);
    await addPost(authorB, qOnlyBlocked);
    const soloA = await addPost(authorA, null);
    const soloB = await addPost(authorB, null);
    const soloM = await addPost(authorM, null);

    // Anonymous control: everything is visible.
    const anon = await readStories();
    assert.ok(storyByKey(anon, String(qMix)), 'anon: mixed story present');
    assert.ok(
      storyByKey(anon, String(qOnlyBlocked)),
      'anon: blocked-only story present'
    );
    assert.ok(storyByKey(anon, `post:${soloB}`), 'anon: blocked solo present');

    // Viewer: blocked/muted authors' posts are removed everywhere.
    const mine = await readStories({
      authorization: `Bearer ${viewerToken}`,
    });
    const mix = storyByKey(mine, String(qMix));
    assert.ok(mix, 'viewer: mixed story still present');
    assert.deepEqual(
      mix.posts.map((p) => p.id),
      [mixPostA],
      'viewer: mixed story keeps only the unblocked author post'
    );
    assert.equal(
      storyByKey(mine, String(qOnlyBlocked)),
      undefined,
      'viewer: story with only blocked-author posts is dropped'
    );
    assert.equal(
      storyByKey(mine, `post:${soloB}`),
      undefined,
      'viewer: blocked author standalone story is dropped'
    );
    assert.equal(
      storyByKey(mine, `post:${soloM}`),
      undefined,
      'viewer: muted author standalone story is dropped'
    );
    assert.ok(
      storyByKey(mine, `post:${soloA}`),
      'viewer: normal author standalone story stays'
    );
    void soloA;
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  try {
    if (owned.blocks.length)
      await db.delete(userBlocks).where(inArray(userBlocks.id, owned.blocks));
    if (owned.mutes.length)
      await db.delete(userMutes).where(inArray(userMutes.id, owned.mutes));
    if (owned.posts.length)
      await db.delete(posts).where(inArray(posts.id, owned.posts));
    if (owned.questions.length)
      await db.delete(questions).where(inArray(questions.id, owned.questions));
    if (owned.topics.length)
      await db.delete(dailyTopics).where(inArray(dailyTopics.id, owned.topics));
    if (owned.users.length)
      await db.delete(users).where(inArray(users.id, owned.users));
  } finally {
    setSystemTime();
    await closeDatabase();
  }
}
console.log(
  `STORIES_STATUS_FIXTURE_OK ${scenario} ${runId} owned rows cleaned`
);
process.exit(0);
