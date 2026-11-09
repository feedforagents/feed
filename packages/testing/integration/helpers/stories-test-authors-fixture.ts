// Invoked only in a fresh process by stories-test-authors.integration.test.ts.
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

const { closeDatabase, dailyTopics, db, eq, inArray, posts, questions, users } =
  await import('@feed/db');
const { StaticDataRegistry } = await import('@feed/engine');
const { NextRequest } = await import('next/server');
const { GET } = await import(
  '../../../../apps/web/src/app/api/feed/stories/route'
);

const scenario = process.argv[2];
const runId = crypto.randomUUID();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  topics: [] as string[],
};
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// A private future UTC day separates our query windows from concurrent normal
// integration data. Check the unique topic date before acquiring ownership.
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

const normal = crypto.randomUUID();
const flagged = crypto.randomUUID();
const prefix = `test-${crypto.randomUUID()}`;
const prefixWithoutUser = `test-${crypto.randomUUID()}`;
const topicKey = `stories-${runId}`;
const questionNumber =
  1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
const seen = new Map<string, string>();

async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  ownership.push(...inserted.map((row) => row.id));
}

async function addPost(
  label: string,
  authorId: string,
  ageHours = 1,
  linked = false
) {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(posts)
    .values({
      id,
      authorId,
      content: `Cobalt satellites orbital observatory ${label} ${runId}`,
      timestamp: new Date(now.getTime() - ageHours * hour),
      createdAt: now,
      relatedQuestion: linked ? questionNumber : null,
    })
    .returning({ id: posts.id });
  owned.posts.push(...inserted.map((row) => row.id));
  seen.set(label, id);
  return id;
}

async function readPosts() {
  const response = await GET(
    new NextRequest('http://localhost/api/feed/stories?limit=20')
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as {
    topic: { topicKey: string };
    stories: Array<{ posts: Array<{ id: string }> }>;
  };
  assert.equal(body.topic.topicKey, topicKey);
  return body.stories.flatMap((story) => story.posts.map((post) => post.id));
}

function assertVisibility(ids: string[], visible: string[], hidden: string[]) {
  for (const label of visible) {
    const id = seen.get(label);
    assert.ok(id && ids.includes(id), `Missing eligible fixture ${label}`);
  }
  for (const label of hidden) {
    const id = seen.get(label);
    assert.ok(id && !ids.includes(id), `Leaked test-author fixture ${label}`);
  }
}

try {
  await insertUsers([
    { id: normal, username: `stories-${runId}`, isTest: false, updatedAt: now },
    { id: flagged, username: `flag-${runId}`, isTest: true, updatedAt: now },
    { id: prefix, username: `prefix-${runId}`, isTest: false, updatedAt: now },
  ]);
  if (scenario === 'partial-setup') {
    const pending: string[] = [];
    const rejectedId = crypto.randomUUID();
    await assert.rejects(
      insertUsers(
        [
          { id: rejectedId, updatedAt: now },
          { id: normal, updatedAt: now },
        ],
        pending
      ),
      (error: Error) => {
        const cause = 'cause' in error ? error.cause : error;
        return (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === '23505'
        );
      }
    );
    assert.deepEqual(pending, []);
    assert.equal(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, rejectedId))
      ).length,
      0
    );
    assert.equal(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, normal))
      ).length,
      1
    );
  } else {
    const insertedTopic = await db
      .insert(dailyTopics)
      .values({
        id: crypto.randomUUID(),
        date: topicDate,
        topicKey,
        topicLabel: 'Cobalt satellites',
        summary: 'Orbital observatory satellites',
        sourceType: 'manual_override',
        sourceHeadlineIds: [],
        updatedAt: now,
      })
      .returning({ id: dailyTopics.id });
    owned.topics.push(...insertedTopic.map((row) => row.id));
    const insertedQuestion = await db
      .insert(questions)
      .values({
        id: crypto.randomUUID(),
        questionNumber,
        text: `Cobalt satellites ${runId}`,
        scenarioId: 1,
        outcome: false,
        rank: 1,
        status: 'active',
        topicKey,
        resolutionDate: new Date(now.getTime() + 7 * day),
        updatedAt: now,
        createdAt: new Date(now.getTime() - 8 * day),
        createdDate: new Date(now.getTime() - 8 * day),
      })
      .returning({ id: questions.id });
    owned.questions.push(...insertedQuestion.map((row) => row.id));
    if (scenario === 'npc-and-no-user') {
      const registryUsers = await db
        .select({ id: users.id, isTest: users.isTest })
        .from(users);
      const testUserIds = new Set(
        registryUsers.filter((row) => row.isTest).map((row) => row.id)
      );
      const npc = StaticDataRegistry.getAllActors().find(
        (actor) => !testUserIds.has(actor.id) && !actor.id.startsWith('test-')
      );
      assert.ok(npc, 'An eligible canonical NPC is required');
      const noUser = crypto.randomUUID();
      assert.equal(
        (
          await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, noUser))
        ).length,
        0
      );
      await addPost('npc', npc.id);
      await addPost('no-user', noUser);
      assertVisibility(await readPosts(), ['npc', 'no-user'], []);
      assert.equal(
        (
          await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, noUser))
        ).length,
        0
      );
    } else {
      const age =
        scenario === 'topic-backfill'
          ? 30
          : scenario === 'keyword-backfill'
            ? 48
            : 1;
      const linked =
        scenario === 'recent-linked' || scenario === 'topic-backfill';
      await addPost('normal', normal, age, linked);
      await addPost('flagged', flagged, age, linked);
      await addPost('prefix-user', prefix, age, linked);
      await addPost('prefix-no-user', prefixWithoutUser, age, linked);
      const initial = await readPosts();
      assertVisibility(
        initial,
        ['normal'],
        ['flagged', 'prefix-user', 'prefix-no-user']
      );
      if (scenario === 'cache') {
        await addPost('new-normal', normal);
        await addPost('new-flagged', flagged);
        assertVisibility(
          await readPosts(),
          ['normal'],
          ['new-normal', 'new-flagged']
        );
        // Controlled-clock memory-cache proof; real elapsed Redis expiry is a
        // separate production HTTP acceptance check, not simulated here.
        setSystemTime(new Date(now.getTime() + 61_000));
        assertVisibility(
          await readPosts(),
          ['normal', 'new-normal'],
          ['flagged', 'new-flagged', 'prefix-user', 'prefix-no-user']
        );
      }
    }
  }
} finally {
  try {
    if (owned.posts.length)
      await db.delete(posts).where(inArray(posts.id, owned.posts));
    if (owned.questions.length)
      await db.delete(questions).where(inArray(questions.id, owned.questions));
    if (owned.topics.length)
      await db.delete(dailyTopics).where(inArray(dailyTopics.id, owned.topics));
    if (owned.users.length)
      await db.delete(users).where(inArray(users.id, owned.users));
    for (const [table, ids] of [
      [posts, owned.posts],
      [questions, owned.questions],
      [dailyTopics, owned.topics],
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
console.log(`STORIES_FIXTURE_OK ${scenario} ${runId} owned rows cleaned`);
process.exit(0);
