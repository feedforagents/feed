/** PRD §12 / MVP Phase 5: deleted posts must not circulate inside retained quotes. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const raw = process.env.DATABASE_URL ?? '';
const database = new URL(raw);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== raw ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');

const control = postgres(raw, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
type Receipt = { id: string; canonical: string };
type Owned = { users: Receipt[]; posts: Receipt[] };
const owned: Owned = { users: [], posts: [] };
const controls: Owned = { users: [], posts: [] };
const onboarding: Receipt[] = [];
const outsiders: Owned = { users: [], posts: [] };
const logicalRows: Array<{
  table: 'Reaction' | 'Post' | 'Follow';
  receipt: Receipt;
}> = [];
const nonce = randomUUID();
const DELETED_BODY = `F66 deleted original body ${nonce}`;
const LIVE_BODY = `F66 live original body ${nonce}`;
const ROOT = resolve(import.meta.dir, '../../..');
const runtime = mkdtempSync(join(tmpdir(), 'feed-narrative-quote-'));
let stopServer: (() => Promise<void>) | undefined;
let origin = '';
let authorA = '';
let authorB = '';
let deletedOriginalId = '';
let quoteOfDeletedId = '';
let repostOfDeletedId = '';
let liveOriginalId = '';
let quoteOfLiveId = '';
let probeId = '';
let authorToken = '';
let quoterToken = '';
const postSchema = z.object({
  id: z.string(),
  content: z.string(),
  isRepost: z.boolean().optional(),
  isQuote: z.boolean().optional(),
  originalPostId: z.string().nullable().optional(),
  originalPost: z
    .object({ id: z.string(), content: z.string(), authorId: z.string() })
    .nullable()
    .optional(),
});
const narrativeSchema = z.object({
  success: z.literal(true),
  stories: z.array(
    z.object({ storyKey: z.string(), posts: z.array(postSchema) })
  ),
});
type NarrativeBody = z.infer<typeof narrativeSchema>;
let body: NarrativeBody;
let warmBody: NarrativeBody;

async function cleanup(scope: Owned) {
  if (!scope.posts.length && !scope.users.length) return;
  await control.begin(async (tx) => {
    for (const row of [...scope.users].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ))
      await tx.unsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [row.id]);
    for (const row of [...scope.posts].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ))
      await tx.unsafe('SELECT id FROM "Post" WHERE id=$1 FOR UPDATE', [row.id]);
    for (const row of scope.posts) {
      const removed = await tx.unsafe<Receipt[]>(
        `DELETE FROM "Post" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb
        AND NOT EXISTS(SELECT 1 FROM "Reaction" WHERE "postId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Comment" WHERE "postId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Share" WHERE "postId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "PostTag" WHERE "postId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Post" child WHERE (child."originalPostId"=t.id OR child."commentOnPostId"=t.id OR child."parentCommentId"=t.id) AND child.id NOT IN(SELECT jsonb_array_elements_text($3::text::jsonb)))
        RETURNING id,to_jsonb(t)::text AS canonical`,
        [
          row.id,
          row.canonical,
          JSON.stringify(scope.posts.map((post) => post.id)),
        ]
      );
      if (removed.length !== 1)
        throw new Error('Owned narrative cleanup refused');
    }
    for (const row of scope.users) {
      const removed = await tx.unsafe<Receipt[]>(
        `DELETE FROM "User" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb
        AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "AdminRole" WHERE "userId"=t.id OR "grantedBy"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Post" WHERE "authorId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Follow" WHERE "followerId"=t.id OR "followingId"=t.id)
        RETURNING id,to_jsonb(t)::text AS canonical`,
        [row.id, row.canonical]
      );
      if (removed.length !== 1)
        throw new Error('Owned narrative cleanup refused');
    }
  });
  scope.posts.length = 0;
  scope.users.length = 0;
}
async function readLogical(table: 'Reaction' | 'Post' | 'Follow', id: string) {
  return Array.from(
    await control.unsafe<Receipt[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${table}" t WHERE id=$1`,
      [id]
    )
  );
}
async function releaseLogicalRows() {
  for (const { table, receipt } of logicalRows) {
    const removed = await control.unsafe<Receipt[]>(
      `DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical`,
      [receipt.id, receipt.canonical]
    );
    if (removed.length !== 1)
      throw new Error('Owned logical sentinel cleanup refused');
  }
  logicalRows.length = 0;
}
async function releaseOnboarding() {
  for (const row of onboarding) {
    const removed =
      await control`DELETE FROM "GameOnboarding" t WHERE id=${row.id} AND to_jsonb(t)=${row.canonical}::text::jsonb RETURNING id`;
    if (removed.length !== 1) throw new Error('Owned sentinel cleanup refused');
  }
  onboarding.length = 0;
}
async function snapshot(scope = owned) {
  const rows: Receipt[] = [];
  for (const row of scope.posts) {
    const [found] = await control<
      Receipt[]
    >`SELECT id,to_jsonb(t)::text AS canonical FROM "Post" t WHERE id=${row.id}`;
    if (!found) throw new Error('Owned post missing');
    rows.push(found);
  }
  for (const row of scope.users) {
    const [found] = await control<
      Receipt[]
    >`SELECT id,to_jsonb(t)::text AS canonical FROM "User" t WHERE id=${row.id}`;
    if (!found) throw new Error('Owned author missing');
    rows.push(found);
  }
  return rows;
}
async function call(path: string, method = 'GET', token = '') {
  return fetch(`${origin}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
}
async function narrative() {
  const response = await call('/api/feed/narrative');
  expect(response.status).toBe(200);
  return narrativeSchema.parse(await response.json());
}
function findPost(id: string) {
  return body.stories.flatMap((s) => s.posts).find((p) => p.id === id);
}

async function startOwnedServer() {
  const bid = readFileSync(
    join(ROOT, 'apps/web/.next/BUILD_ID'),
    'utf8'
  ).trim();
  const reservation = createServer();
  const selected = await new Promise<number>((accept, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing loopback port'));
        return;
      }
      reservation.close((error) =>
        error ? reject(error) : accept(address.port)
      );
    });
  });
  origin = `http://127.0.0.1:${selected}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    BUN_ENV: 'production',
    CI: 'false',
    PORT: String(selected),
    ALLOW_TEST_PRIVY_DID_AUTH: 'false',
    DISABLE_RATE_LIMITING: 'false',
    CI_ADMIN_TOKEN: '',
    DEV_ADMIN_TOKEN: '',
    TEST_ADMIN_TOKEN: '',
    TEST_USER_ID: '',
    ADMIN_API_KEY: '',
    AGENT_SECRET: '',
    DATABASE_READ_REPLICA_URL: '',
    POSTGRES_URL: '',
    FEED_DISABLE_REDIS: '1',
    REDIS_URL: '',
    GROQ_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    SURPLUS_API_KEY: '',
    ELIZACLOUD_API_KEY: '',
    NEXT_PUBLIC_APP_URL: origin,
    NEXT_PUBLIC_BASE_URL: origin,
    NEXT_PUBLIC_API_URL: origin,
    FEED_API_URL: origin,
    TEST_API_URL: origin,
    TEST_BASE_URL: origin,
  };
  const log = createWriteStream(join(runtime, 'server.log'), {
    flags: 'wx',
    mode: 0o600,
  });
  const child = spawn(
    process.execPath,
    [
      '--bun',
      join(ROOT, 'apps/web/node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '-p',
      String(selected),
    ],
    { cwd: join(ROOT, 'apps/web'), env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const closed = new Promise<void>((accept) => {
    child.once('close', () => {
      log.end();
      accept();
    });
  });
  stopServer = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && child.signalCode === null) {
      if (Date.now() >= deadline)
        throw new Error('Owned narrative server did not drain');
      await delay(50);
    }
    await Promise.race([
      closed,
      delay(Math.max(1, deadline - Date.now()), undefined, { ref: false }).then(
        () => {
          throw new Error('Owned narrative server pipes did not close');
        }
      ),
    ]);
    if (
      child.exitCode !== 0 &&
      child.exitCode !== 143 &&
      child.signalCode !== 'SIGTERM'
    )
      throw new Error('Owned narrative server exited unexpectedly');
    writeFileSync(
      join(runtime, 'server-stopped.json'),
      JSON.stringify({
        pid: child.pid,
        exit: child.exitCode,
        signal: child.signalCode,
        BID: bid,
      }),
      { mode: 0o600, flag: 'wx' }
    );
    if (
      readFileSync(join(ROOT, 'apps/web/.next/BUILD_ID'), 'utf8').trim() !== bid
    )
      throw new Error('Build changed during narrative fixture');
  };
  writeFileSync(
    join(runtime, 'server-owned.json'),
    JSON.stringify({
      pid: child.pid,
      origin,
      BID: bid,
      database: database.pathname.slice(1),
      normalAuth: true,
    }),
    { mode: 0o600, flag: 'wx' }
  );
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Owned narrative server exited before health');
    try {
      const response = await call('/api/health');
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException))
        throw error;
    }
    await delay(100);
  }
  throw new Error('Owned narrative server health deadline');
}

beforeAll(async () => {
  const [actual] = await control<
    { name: string; role: string; port: number; primary: boolean }[]
  >`SELECT current_database() AS name,current_user AS role,inet_server_port() AS port,NOT pg_is_in_recovery() AS primary`;
  if (
    !actual ||
    actual.name !== database.pathname.slice(1) ||
    actual.role !== database.username ||
    actual.port !== Number(port) ||
    !actual.primary
  )
    throw new Error('Disposable database identity mismatch');
  authorA = await generateSnowflakeId();
  authorB = await generateSnowflakeId();
  [
    deletedOriginalId,
    quoteOfDeletedId,
    repostOfDeletedId,
    liveOriginalId,
    quoteOfLiveId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  if (
    !deletedOriginalId ||
    !quoteOfDeletedId ||
    !repostOfDeletedId ||
    !liveOriginalId ||
    !quoteOfLiveId
  )
    throw new Error('Missing intended post ID');
  const pending: Owned = { users: [], posts: [] };
  await control.begin(async (tx) => {
    for (const [id, index] of [
      [authorA, 0],
      [authorB, 1],
    ] as const)
      pending.users.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "User"(id,username,"stewardId","updatedAt") VALUES($1,$2,$3,now()) RETURNING id,to_jsonb("User")::text AS canonical',
          [id, `f66_${id}`, `${nonce}-${index}`]
        ))
      );
    for (const [id, content, author, type, original] of [
      [deletedOriginalId, DELETED_BODY, authorA, 'post', null],
      [liveOriginalId, LIVE_BODY, authorA, 'post', null],
      [
        quoteOfDeletedId,
        'F66 quote commentary',
        authorB,
        'repost',
        deletedOriginalId,
      ],
      [repostOfDeletedId, '', authorB, 'repost', deletedOriginalId],
      [
        quoteOfLiveId,
        'F66 live quote commentary',
        authorB,
        'repost',
        liveOriginalId,
      ],
    ] as const)
      pending.posts.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "Post"(id,content,"authorId",type,"originalPostId",timestamp,"createdAt") VALUES($1,$2,$3,$4,$5,now(),now()) RETURNING id,to_jsonb("Post")::text AS canonical',
          [id, content, author, type, original]
        ))
      );
  });
  owned.users.push(...pending.users);
  owned.posts.push(...pending.posts);
  expect(owned.users).toHaveLength(2);
  expect(owned.posts).toHaveLength(5);
  authorToken = await createStewardTestToken(`${nonce}-0`);
  quoterToken = await createStewardTestToken(`${nonce}-1`);
  await startOwnedServer();
  const previous = owned.posts.find((p) => p.id === deletedOriginalId);
  if (!previous) throw new Error('Missing acquired original');
  const started = new Date().toISOString();
  const deleted = await call(
    `/api/posts/${deletedOriginalId}`,
    'DELETE',
    authorToken
  );
  expect(deleted.status).toBe(200);
  await deleted.arrayBuffer();
  const finished = new Date().toISOString();
  const [updated] = await control<
    Receipt[]
  >`SELECT id,to_jsonb(t)::text AS canonical FROM "Post" t WHERE id=${deletedOriginalId} AND "deletedAt" IS NOT NULL AND "deletedAt">=${started}::text::timestamp AND "deletedAt"<=${finished}::text::timestamp AND to_jsonb(t)-'deletedAt'=${previous.canonical}::text::jsonb-'deletedAt'`;
  if (!updated) throw new Error('Unexpected soft-delete tuple transition');
  previous.canonical = updated.canonical;
  // The first narrative GET runs only after the real deletion, in this fresh host.
  // Its repeat tests that same snapshot, not immediate invalidation of a previously warm snapshot.
  body = await narrative();
  probeId = await generateSnowflakeId();
  const probe = await control<
    Receipt[]
  >`INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt") VALUES(${probeId},'F66 warm-cache probe',${authorB},now(),now()) RETURNING id,to_jsonb("Post")::text AS canonical`;
  owned.posts.push(...probe);
  expect(probe).toHaveLength(1);
  warmBody = await narrative();
}, 30000);

afterAll(async () => {
  try {
    await releaseLogicalRows();
    await releaseOnboarding();
    await cleanup(controls);
    await cleanup(outsiders);
    await cleanup(owned);
  } finally {
    authorToken = '';
    quoterToken = '';
    try {
      await stopServer?.();
    } finally {
      await control.end({ timeout: 5 });
    }
  }
}, 30000);

describe('narrative feed quote embeds vs deleted originals', () => {
  it('warm-cache control: a repeat serves the same pre-probe snapshot', () => {
    expect(warmBody.stories).toEqual(body.stories);
    expect(
      warmBody.stories.flatMap((s) => s.posts).map((p) => p.id)
    ).not.toContain(probeId);
  });
  it('keeps the quote post itself in the feed', () => {
    const quote = findPost(quoteOfDeletedId);
    expect(quote).toBeDefined();
    expect(quote?.content).toBe('F66 quote commentary');
  });
  it('does not embed a deleted original inside a quote post', () => {
    expect(findPost(quoteOfDeletedId)?.originalPost).toBeNull();
  });
  it('does not embed a deleted original inside a simple repost', () => {
    const repost = findPost(repostOfDeletedId);
    expect(repost).toBeDefined();
    expect(repost?.originalPost).toBeNull();
  });
  it('never leaks the deleted post body anywhere in the response', () => {
    expect(JSON.stringify(body)).not.toContain(DELETED_BODY);
  });
  it('does not list the deleted original as a top-level post', () => {
    expect(findPost(deletedOriginalId)).toBeUndefined();
  });
  it('still embeds a live original inside its quote post', () => {
    const quote = findPost(quoteOfLiveId);
    expect(quote).toBeDefined();
    expect(quote?.originalPost?.id).toBe(liveOriginalId);
    expect(quote?.originalPost?.content).toBe(LIVE_BODY);
  });
  it('refuses missing authentication and foreign-owner deletion without changing owned rows', async () => {
    const before = await snapshot();
    for (const [token, status] of [
      ['', 401],
      [quoterToken, 400],
    ] as const) {
      const response = await call(
        `/api/posts/${liveOriginalId}`,
        'DELETE',
        token
      );
      expect(response.status).toBe(status);
      await response.arrayBuffer();
    }
    expect(await snapshot()).toEqual(before);
  });
  it('fixture ownership: a colliding insert registers nothing and cleanup leaves pre-existing rows untouched', async () => {
    const victimUser = await generateSnowflakeId();
    const victimPost = await generateSnowflakeId();
    const pending: Owned = { users: [], posts: [] };
    await control.begin(async (tx) => {
      pending.users.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now()) RETURNING id,to_jsonb("User")::text AS canonical',
          [victimUser, `f66_${victimUser}`]
        ))
      );
      pending.posts.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt") VALUES($1,$2,$3,now(),now()) RETURNING id,to_jsonb("Post")::text AS canonical',
          [victimPost, 'F66 pre-existing post', victimUser]
        ))
      );
    });
    controls.users.push(...pending.users);
    controls.posts.push(...pending.posts);
    expect(controls.users).toHaveLength(1);
    expect(controls.posts).toHaveLength(1);
    const before = await snapshot(controls);
    const planned = await generateSnowflakeId();
    await expect(
      control.begin(async (tx) => {
        await tx.unsafe(
          'INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt") VALUES($1,$2,$3,now(),now())',
          [planned, 'F66 rollback probe', authorB]
        );
        await tx.unsafe(
          'INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt") VALUES($1,$2,$3,now(),now())',
          [victimPost, 'F66 colliding candidate', authorB]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'Post_pkey' });
    expect(
      await control`SELECT id FROM "Post" WHERE id=${planned}`
    ).toHaveLength(0);
    expect(owned.posts.map((p) => p.id)).not.toContain(victimPost);
    await cleanup(owned);
    expect(await snapshot(controls)).toEqual(before);
    await cleanup(controls);
  });
  it('fixture ownership: foreign cascading and logical children refuse cleanup atomically', async () => {
    const id = await generateSnowflakeId();
    const postId = await generateSnowflakeId();
    const outsiderId = await generateSnowflakeId();
    const pending: Owned = { users: [], posts: [] };
    const outside: Receipt[] = [];
    await control.begin(async (tx) => {
      pending.users.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now()) RETURNING id,to_jsonb("User")::text AS canonical',
          [id, `f66_${id}`]
        ))
      );
      pending.posts.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt") VALUES($1,$2,$3,now(),now()) RETURNING id,to_jsonb("Post")::text AS canonical',
          [postId, 'F66 guarded parent', id]
        ))
      );
      outside.push(
        ...(await tx.unsafe<Receipt[]>(
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now()) RETURNING id,to_jsonb("User")::text AS canonical',
          [outsiderId, `f66_${outsiderId}`]
        ))
      );
    });
    controls.users.push(...pending.users);
    controls.posts.push(...pending.posts);
    outsiders.users.push(...outside);
    expect(controls.users).toHaveLength(1);
    expect(controls.posts).toHaveLength(1);
    expect(outsiders.users).toHaveLength(1);
    const before = await snapshot(controls);
    async function refuse() {
      await expect(cleanup(controls)).rejects.toThrow(
        'Owned narrative cleanup refused'
      );
      expect(await snapshot(controls)).toEqual(before);
    }
    const sentinel = await control<
      Receipt[]
    >`INSERT INTO "GameOnboarding"(id,"userId") VALUES(${await generateSnowflakeId()},${id}) RETURNING id,to_jsonb("GameOnboarding")::text AS canonical`;
    onboarding.push(...sentinel);
    expect(sentinel).toHaveLength(1);
    try {
      await refuse();
    } finally {
      await releaseOnboarding();
    }
    const reaction = await control<
      Receipt[]
    >`INSERT INTO "Reaction"(id,"postId","userId",type) VALUES(${await generateSnowflakeId()},${postId},${outsiderId},'like') RETURNING id,to_jsonb("Reaction")::text AS canonical`;
    logicalRows.push(
      ...reaction.map((receipt) => ({ table: 'Reaction' as const, receipt }))
    );
    expect(reaction).toHaveLength(1);
    try {
      await refuse();
      expect(await readLogical('Reaction', reaction[0]?.id ?? '')).toEqual(
        Array.from(reaction)
      );
    } finally {
      await releaseLogicalRows();
    }
    for (const [author, original] of [
      [outsiderId, postId],
      [id, null],
    ] as const) {
      const child = await control<
        Receipt[]
      >`INSERT INTO "Post"(id,content,"authorId","originalPostId",timestamp,"createdAt") VALUES(${await generateSnowflakeId()},'F66 separately acquired child',${author},${original},now(),now()) RETURNING id,to_jsonb("Post")::text AS canonical`;
      logicalRows.push(
        ...child.map((receipt) => ({ table: 'Post' as const, receipt }))
      );
      expect(child).toHaveLength(1);
      try {
        await refuse();
        expect(await readLogical('Post', child[0]?.id ?? '')).toEqual(
          Array.from(child)
        );
      } finally {
        await releaseLogicalRows();
      }
    }
    for (const [follower, following] of [
      [outsiderId, id],
      [id, outsiderId],
    ] as const) {
      const edge = await control<
        Receipt[]
      >`INSERT INTO "Follow"(id,"followerId","followingId") VALUES(${await generateSnowflakeId()},${follower},${following}) RETURNING id,to_jsonb("Follow")::text AS canonical`;
      logicalRows.push(
        ...edge.map((receipt) => ({ table: 'Follow' as const, receipt }))
      );
      expect(edge).toHaveLength(1);
      try {
        await refuse();
        expect(await readLogical('Follow', edge[0]?.id ?? '')).toEqual(
          Array.from(edge)
        );
      } finally {
        await releaseLogicalRows();
      }
    }
    await cleanup(controls);
    await cleanup(outsiders);
  });
});
