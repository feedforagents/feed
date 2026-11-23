// Invoked only in a fresh process by
// narrative-viewer-moderation.integration.test.ts.
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';

import { createStewardTestToken } from './steward-auth';
import { verifySubMarketChildLease } from './sub-market-isolation';

await verifySubMarketChildLease();
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

// Next's server-only marker is the only stub. Auth, PostgreSQL, the routes
// and the shared in-process cache all execute their production source.
mock.module('server-only', () => ({}));

const { optionalAuth } = await import('@feed/api');
const {
  closeDatabase,
  db,
  posts,
  questions,
  reactions,
  userBlocks,
  userMutes,
  users,
} = await import('@feed/db');
const { NextRequest } = await import('next/server');
const { GET: narrativeGET } = await import(
  '../../../../apps/web/src/app/api/feed/narrative/route'
);
const { GET: storiesGET } = await import(
  '../../../../apps/web/src/app/api/feed/stories/route'
);

const scenarios = ['viewer', 'repost', 'mixed'];
const scenario = process.argv[2] ?? '';
const scenarioIndex = scenarios.indexOf(scenario);
assert.notEqual(scenarioIndex, -1, `Unknown scenario ${scenario}`);
const runId = crypto.randomUUID();
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// Separate the query windows of the three processes in the owned database.
const now = new Date(Date.UTC(2041, 3, 12 + 30 * scenarioIndex, 12));
setSystemTime(now);

const viewer = crypto.randomUUID();
const viewerStewardId = crypto.randomUUID();
const viewerToken = await createStewardTestToken(viewerStewardId);
const normal = crypto.randomUUID();
const blocked = crypto.randomUUID();
const muted = crypto.randomUUID();
const blocker = crypto.randomUUID();
const likers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const seen = new Map<string, string>();

async function insertUsers(values: Array<typeof users.$inferInsert>) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  assert.equal(inserted.length, values.length);
}

async function insertQuestion(): Promise<number> {
  const questionNumber =
    1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
  const id = crypto.randomUUID();
  await db.insert(questions).values({
    id,
    questionNumber,
    text: `Narrative moderation ${runId}`,
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
  questionNumber: number | null,
  opts: { likes?: boolean; type?: string; originalPostId?: string } = {}
) {
  const id = crypto.randomUUID();
  await db.insert(posts).values({
    id,
    authorId,
    content:
      opts.type === 'repost'
        ? ''
        : `Narrative moderation probe ${label} ${runId}`,
    timestamp: new Date(now.getTime() - hour),
    createdAt: now,
    relatedQuestion: questionNumber,
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.originalPostId ? { originalPostId: opts.originalPostId } : {}),
  });

  seen.set(label, id);
  if (opts.likes) {
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
  return id;
}

type StoryShape = {
  stories: Array<{
    posts: Array<{ id: string; originalPost: { id: string } | null }>;
  }>;
};

type NextRequestInstance = InstanceType<typeof NextRequest>;

/** Every post id a response exposes, including embedded repost originals. */
async function readSurface(
  handler: (req: NextRequestInstance) => Promise<Response>,
  url: string,
  asViewer: boolean
): Promise<string[]> {
  const request = new NextRequest(
    url,
    asViewer
      ? {
          headers: {
            Authorization: `Bearer ${viewerToken}`,
          },
        }
      : undefined
  );
  const response = await handler(request);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    response.headers.get('cache-control'),
    asViewer
      ? 'private, no-store'
      : 'public, s-maxage=5, stale-while-revalidate=10',
    asViewer
      ? 'viewer request did not resolve to an authenticated viewer'
      : 'anonymous response did not retain public caching'
  );
  const body = (await response.json()) as StoryShape;
  const ids: string[] = [];
  for (const story of body.stories) {
    for (const post of story.posts) {
      ids.push(post.id);
      if (post.originalPost) ids.push(post.originalPost.id);
    }
  }
  return ids;
}

function assertVisibility(
  surface: string,
  ids: string[],
  visible: string[],
  hidden: string[]
) {
  for (const label of visible) {
    const id = seen.get(label);
    assert.ok(id && ids.includes(id), `${surface}: missing fixture ${label}`);
  }
  for (const label of hidden) {
    const id = seen.get(label);
    assert.ok(
      id && !ids.includes(id),
      `${surface}: leaked moderated fixture ${label}`
    );
  }
}

const AUTHORS: Array<[string, string]> = [
  ['normal', normal],
  ['blocked', blocked],
  ['muted', muted],
  ['blocker', blocker],
];
const MODERATED_LABELS = ['blocked', 'muted', 'blocker'];

try {
  await insertUsers([
    {
      id: viewer,
      username: `viewer-${runId}`,
      stewardId: viewerStewardId,
      isTest: false,
      updatedAt: now,
    },
    ...AUTHORS.map(([label, id]) => ({
      id,
      username: `${label}-${runId}`,
      isTest: false,
      updatedAt: now,
    })),
    ...likers.map((id) => ({
      id,
      username: `liker-${id.slice(0, 8)}-${runId}`,
      isTest: false,
      updatedAt: now,
    })),
  ]);

  const identity = await optionalAuth(
    new NextRequest('http://localhost/api/feed/narrative', {
      headers: { Authorization: `Bearer ${viewerToken}` },
    })
  );
  assert.equal(
    identity?.userId,
    viewer,
    'Steward token must resolve the viewer'
  );

  // The viewer's moderation state: blocked and muted are the viewer's own
  // choices; blocker has blocked the viewer.
  const blockId1 = crypto.randomUUID();
  await db.insert(userBlocks).values({
    id: blockId1,
    blockerId: viewer,
    blockedId: blocked,
    createdAt: now,
  });

  const blockId2 = crypto.randomUUID();
  await db.insert(userBlocks).values({
    id: blockId2,
    blockerId: blocker,
    blockedId: viewer,
    createdAt: now,
  });

  const muteId = crypto.randomUUID();
  await db.insert(userMutes).values({
    id: muteId,
    muterId: viewer,
    mutedId: muted,
    createdAt: now,
  });

  if (scenario === 'viewer') {
    // One question per author so every linked post leads its own story, plus
    // a liked standalone post per author for the general/spillover cards.
    for (const [label, authorId] of AUTHORS) {
      await addPost(`${label}-linked`, authorId, await insertQuestion());
      await addPost(`${label}-solo`, authorId, null, { likes: true });
    }
    const allLabels = AUTHORS.flatMap(([label]) => [
      `${label}-linked`,
      `${label}-solo`,
    ]);
    const hiddenLabels = MODERATED_LABELS.flatMap((label) => [
      `${label}-linked`,
      `${label}-solo`,
    ]);

    const viewerIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      true
    );
    assertVisibility(
      'narrative-viewer',
      viewerIds,
      ['normal-linked', 'normal-solo'],
      hiddenLabels
    );

    // The shared cache must stay global: an anonymous read after the
    // viewer's filtered read still returns every post.
    const anonIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      false
    );
    assertVisibility('narrative-anon-after-viewer', anonIds, allLabels, []);

    // And a second viewer read is still filtered (no cache poisoning in
    // either direction).
    const viewerIds2 = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      true
    );
    assertVisibility(
      'narrative-viewer-again',
      viewerIds2,
      ['normal-linked', 'normal-solo'],
      hiddenLabels
    );

    // Control: the canonical stories surface filters the same fixture.
    const storiesIds = await readSurface(
      storiesGET,
      'http://localhost/api/feed/stories',
      true
    );
    assertVisibility(
      'stories-viewer-control',
      storiesIds,
      ['normal-linked'],
      MODERATED_LABELS.map((label) => `${label}-linked`)
    );
  } else if (scenario === 'repost') {
    // A normal author's repost embeds the blocked author's original post.
    const questionNumber = await insertQuestion();
    await addPost('blocked-original', blocked, questionNumber);
    await addPost('normal-repost', normal, questionNumber, {
      type: 'repost',
      originalPostId: seen.get('blocked-original'),
    });

    const viewerIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      true
    );
    assertVisibility(
      'narrative-viewer-repost',
      viewerIds,
      [],
      ['blocked-original', 'normal-repost']
    );

    const anonIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      false
    );
    assertVisibility(
      'narrative-anon-repost',
      anonIds,
      ['blocked-original', 'normal-repost'],
      []
    );
  } else if (scenario === 'mixed') {
    // One story mixing a normal author's post with moderated authors' posts:
    // the viewer keeps the story but only the normal post inside it.
    const questionNumber = await insertQuestion();
    await addPost('normal-linked', normal, questionNumber);
    await addPost('blocked-linked', blocked, questionNumber);
    await addPost('muted-linked', muted, questionNumber);

    const viewerIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      true
    );
    assertVisibility(
      'narrative-viewer-mixed',
      viewerIds,
      ['normal-linked'],
      ['blocked-linked', 'muted-linked']
    );

    const anonIds = await readSurface(
      narrativeGET,
      'http://localhost/api/feed/narrative',
      false
    );
    assertVisibility(
      'narrative-anon-mixed',
      anonIds,
      ['normal-linked', 'blocked-linked', 'muted-linked'],
      []
    );
  }
} finally {
  setSystemTime();
  await closeDatabase();
}
console.log(`NARRATIVE_MODERATION_OK ${scenario}`);
process.exit(0);
