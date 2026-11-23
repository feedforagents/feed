// Invoked only in a fresh process by
// feed-story-author-eligibility.integration.test.ts.
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';
import { verifySubMarketChildLease } from './sub-market-isolation';

await verifySubMarketChildLease();
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

// This marker is the only module stub. Auth, PostgreSQL, candidate queries and
// getCacheOrFetch's memory backend/TTL all execute their production source.
mock.module('server-only', () => ({}));

const { closeDatabase, db, posts, questions, reactions, users } = await import(
  '@feed/db'
);
const { NextRequest } = await import('next/server');
const { GET: narrativeGET } = await import(
  '../../../../apps/web/src/app/api/feed/narrative/route'
);
const { GET: forYouGET } = await import(
  '../../../../apps/web/src/app/api/feed/for-you/route'
);

const scenario = process.argv[2];
const windowOffset = Number(process.argv[3]);
assert.ok([0, 1, 2].includes(windowOffset));
const runId = crypto.randomUUID();
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// The feed looks back up to 30 days. Leave 40 days between scenarios so their
// fixtures can share one disposable database without affecting each other.
const now = new Date(Date.UTC(2041, 2, 10, 12, 0, 0) + windowOffset * 40 * day);
setSystemTime(now);

const normal = crypto.randomUUID();
const normalWithoutUser = crypto.randomUUID();
const flagged = crypto.randomUUID();
const prefix = `test-${crypto.randomUUID()}`;
const prefixWithoutUser = `test-${crypto.randomUUID()}`;
const likers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const seen = new Map<string, string>();

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
  ['normalnouser', normalWithoutUser],
  ['flagged', flagged],
  ['prefix', prefix],
  ['prefixnouser', prefixWithoutUser],
];
const TEST_LABELS = ['flagged', 'prefix', 'prefixnouser'];

try {
  await db.insert(users).values([
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
      [
        'normal-linked',
        'normal-solo',
        'normalnouser-linked',
        'normalnouser-solo',
      ],
      TEST_LABELS.flatMap((label) => [`${label}-linked`, `${label}-solo`])
    );
    const forYouIds = await readSurface(
      forYouGET,
      'http://localhost/api/feed/for-you?limit=20'
    );
    assertVisibility(
      'for-you',
      forYouIds,
      [
        'normal-linked',
        'normal-solo',
        'normalnouser-linked',
        'normalnouser-solo',
      ],
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
      ['normal-linked', 'normalnouser-linked'],
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
      ['normal-solo', 'normalnouser-solo'],
      TEST_LABELS.map((label) => `${label}-solo`)
    );
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  setSystemTime();
  await closeDatabase();
}
console.log(`FEED_STORY_ELIGIBILITY_OK ${scenario}`);
process.exit(0);
