// Invoked only in a fresh process by
// narrative-viewer-moderation.integration.test.ts.
import { mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.match(databaseUrl.pathname, /^\/(test_db|feed_pr\d+)$/);
assert.equal(process.env.DATABASE_READ_REPLICA_URL, '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

// This marker is the only module stub. Auth, PostgreSQL, the narrative route
// and getCacheOrFetch's memory backend/TTL all execute their production
// source. The viewer authenticates with a real Steward JWT (HS256, issuer
// 'steward', signed with the non-production dev secret the auth middleware
// falls back to when STEWARD_JWT_SECRET is unset) — publicRateLimit's
// optionalAuth accepts only Steward JWTs and agent sessions, not the
// integration-test DID that authenticate() supports.
mock.module('server-only', () => ({}));

import { createHmac } from 'node:crypto';

function stewardJwt(userId: string, now: Date): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    userId,
    iss: 'steward',
    exp: Math.floor(now.getTime() / 1000) + 3600,
  });
  const signature = createHmac('sha256', 'dev-jwt-secret-change-in-prod')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const {
  closeDatabase,
  db,
  inArray,
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

const scenario = process.argv[2];
const runId = crypto.randomUUID();
const owned = {
  users: [] as string[],
  posts: [] as string[],
  questions: [] as string[],
  reactions: [] as string[],
  blocks: [] as string[],
  mutes: [] as string[],
};
const hour = 60 * 60 * 1000;
const day = 24 * hour;
// A private future UTC day separates our query windows from concurrent normal
// integration data.
const now = new Date(Date.UTC(2041, 3, 12, 12, 0, 0));
setSystemTime(now);

const viewer = crypto.randomUUID();
const viewerStewardId = crypto.randomUUID();
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
  owned.users.push(...inserted.map((row) => row.id));
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
  owned.questions.push(id);
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
  owned.posts.push(id);
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
      owned.reactions.push(rid);
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
            Authorization: ['Bearer', stewardJwt(viewerStewardId, now)].join(
              ' '
            ),
          },
        }
      : undefined
  );
  const response = await handler(request);
  assert.equal(response.status, 200, await response.clone().text());
  if (asViewer) {
    // The narrative route marks authenticated responses private/no-store;
    // an anonymous response would carry public cache headers instead. This
    // pins the viewer calls to a resolved viewer identity, so a silently
    // anonymous run can never masquerade as a filtered (or leaked) one.
    assert.equal(
      response.headers.get('cache-control'),
      'private, no-store',
      'viewer request did not resolve to an authenticated viewer'
    );
  }
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

  // The viewer's moderation state: blocked and muted are the viewer's own
  // choices; blocker has blocked the viewer.
  const blockId1 = crypto.randomUUID();
  await db.insert(userBlocks).values({
    id: blockId1,
    blockerId: viewer,
    blockedId: blocked,
    createdAt: now,
  });
  owned.blocks.push(blockId1);
  const blockId2 = crypto.randomUUID();
  await db.insert(userBlocks).values({
    id: blockId2,
    blockerId: blocker,
    blockedId: viewer,
    createdAt: now,
  });
  owned.blocks.push(blockId2);
  const muteId = crypto.randomUUID();
  await db.insert(userMutes).values({
    id: muteId,
    muterId: viewer,
    mutedId: muted,
    createdAt: now,
  });
  owned.mutes.push(muteId);

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
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  try {
    if (owned.reactions.length)
      await db.delete(reactions).where(inArray(reactions.id, owned.reactions));
    if (owned.blocks.length)
      await db.delete(userBlocks).where(inArray(userBlocks.id, owned.blocks));
    if (owned.mutes.length)
      await db.delete(userMutes).where(inArray(userMutes.id, owned.mutes));
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
console.log(`NARRATIVE_MODERATION_OK ${scenario} ${runId} owned rows cleaned`);
process.exit(0);
