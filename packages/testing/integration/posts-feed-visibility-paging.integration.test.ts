/** PRD §12 / MVP Phase 5: visible Latest posts remain reachable through real HTTP. */
import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const databaseUrl = process.env.DATABASE_URL ?? '';
const database = new URL(databaseUrl);
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
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseUrl ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(base);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
type Table = 'User' | 'Post' | 'UserBlock' | 'UserMute' | 'Reaction';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
type Author =
  | 'viewer'
  | 'otherViewer'
  | 'blocked'
  | 'muted'
  | 'blocker'
  | 'author';
type PostSpec = {
  label: string;
  author?: Author;
  offset: string;
  content?: string;
  original?: string;
  deleted?: boolean;
};
type Fixture = {
  rows: Receipt[];
  users: Map<Author, string>;
  posts: Map<string, string>;
  tokens: Map<Author, string>;
  type: string;
  anchor: string;
};
const fixtures: Receipt[][] = [];
const responseSchema = z.object({
  success: z.literal(true),
  posts: z.array(z.object({ id: z.string() })),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
async function fresh() {
  const value = await generateSnowflakeId();
  if (!isValidSnowflakeId(value))
    throw new Error('Invalid generated fixture ID');
  return value;
}
function lookup(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error(`Missing acquired ${label}`);
  return value;
}
function post(fx: Fixture, label: string) {
  return lookup(fx.posts, label);
}
function user(fx: Fixture, label: Author) {
  const value = fx.users.get(label);
  if (!value) throw new Error('Missing acquired User');
  return value;
}
async function insert(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  table: Table,
  statement: string,
  values: string[]
) {
  const result = await tx.unsafe<Physical[]>(
    `${statement} RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of result) rows.push({ table, ...row });
  if (result.length !== 1)
    throw new Error(`Fixture acquisition failed ${table}`);
}
async function seed(specs: PostSpec[], singleBlock = false) {
  const [identity] = await control<
    { name: string; role: string; port: number; primary: boolean }[]
  >`SELECT current_database() AS name,current_user AS role,inet_server_port() AS port,NOT pg_is_in_recovery() AS primary`;
  if (
    !identity ||
    identity.name !== database.pathname.slice(1) ||
    identity.role !== database.username ||
    identity.port !== Number(port) ||
    !identity.primary
  )
    throw new Error('Disposable database identity mismatch');
  const fx: Fixture = {
    rows: [],
    users: new Map(),
    posts: new Map(),
    tokens: new Map(),
    type: `p1712_${randomUUID()}`,
    anchor: '',
  };
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    // An empty historical slice exercises default Latest without assuming an empty shared DB.
    const [boundary] = await tx.unsafe<{ anchor: string }[]>(
      `SELECT to_char(LEAST(COALESCE(MIN(timestamp),clock_timestamp()::timestamp),clock_timestamp()::timestamp)-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS anchor FROM "Post"`
    );
    if (!boundary) throw new Error('Missing historical feed boundary');
    fx.anchor = boundary.anchor;
    const older = await tx.unsafe(
      'SELECT id FROM "Post" WHERE timestamp<$1::text::timestamp LIMIT 1',
      [fx.anchor]
    );
    if (older.length) throw new Error('Historical fixture slice is not empty');
    for (const label of [
      'viewer',
      'otherViewer',
      'blocked',
      'muted',
      'blocker',
      'author',
    ] as const) {
      const value = await fresh();
      await insert(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","updatedAt") VALUES($1,$2,$3,$4,now())',
        [value, `p1712_${value}`, `${fx.type}-${label}`, `Visibility ${label}`]
      );
      fx.users.set(label, value);
    }
    const blocks: Array<readonly [Author, Author]> = singleBlock
      ? [['viewer', 'blocked']]
      : [
          ['viewer', 'blocked'],
          ['blocker', 'viewer'],
        ];
    for (const [from, to] of blocks)
      await insert(
        tx,
        pending,
        'UserBlock',
        'INSERT INTO "UserBlock"(id,"blockerId","blockedId") VALUES($1,$2,$3)',
        [await fresh(), user(fx, from), user(fx, to)]
      );
    if (!singleBlock)
      await insert(
        tx,
        pending,
        'UserMute',
        'INSERT INTO "UserMute"(id,"muterId","mutedId") VALUES($1,$2,$3)',
        [await fresh(), user(fx, 'viewer'), user(fx, 'muted')]
      );
    for (const spec of specs) {
      const value = await fresh();
      await insert(
        tx,
        pending,
        'Post',
        `INSERT INTO "Post"(id,"authorId",content,type,timestamp,"createdAt","originalPostId","deletedAt") VALUES($1,$2,$3,$4,$5::text::timestamp-$6::text::interval,$5::text::timestamp-$6::text::interval,${spec.original ? '$7' : 'NULL'},${spec.deleted ? 'now()' : 'NULL'})`,
        [
          value,
          user(fx, spec.author ?? 'author'),
          spec.content ?? `Owned ${spec.label}`,
          fx.type,
          fx.anchor,
          `${spec.offset} seconds`,
          ...(spec.original ? [post(fx, spec.original)] : []),
        ]
      );
      fx.posts.set(spec.label, value);
    }
  });
  fx.rows.push(...pending);
  fixtures.push(fx.rows);
  for (const label of ['viewer', 'otherViewer'] as const)
    fx.tokens.set(label, await createStewardTestToken(`${fx.type}-${label}`));
  return fx;
}
const guards: Record<Table, string> = {
  Reaction: '',
  UserBlock: '',
  UserMute: '',
  Post: ' AND NOT EXISTS(SELECT 1 FROM "Post" WHERE "originalPostId"=t.id OR "commentOnPostId"=t.id OR "parentCommentId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment" WHERE "postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Reaction" WHERE "postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Share" WHERE "postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PostTag" WHERE "postId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post" WHERE "authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment" WHERE "authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Reaction" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Share" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserBlock" WHERE "blockerId"=t.id OR "blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute" WHERE "muterId"=t.id OR "mutedId"=t.id)',
};
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Post'] as const)
      for (const row of rows
        .filter((row) => row.table === table)
        .sort((a, b) => a.id.localeCompare(b.id)))
        await tx.unsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [
          row.id,
        ]);
    for (const table of [
      'Reaction',
      'Post',
      'UserBlock',
      'UserMute',
      'User',
    ] as const)
      for (const row of rows.filter((row) => row.table === table).reverse()) {
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${guards[table]} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error(`Owned cleanup refused ${table}`);
      }
  });
  rows.length = 0;
}
async function physical(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const row of rows) {
    const [current] = await control.unsafe<Physical[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Owned fixture row missing');
    result.push({ table: row.table, ...current });
  }
  return result;
}
afterAll(async () => {
  const errors: Error[] = [];
  try {
    for (const rows of [...fixtures].reverse()) {
      try {
        await cleanup(rows);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    await control.end({ timeout: 5 });
  }
  if (errors.length)
    throw new AggregateError(errors, 'Owned feed fixtures retained');
}, 20000);
async function page(
  fx: Fixture,
  query: Record<string, string>,
  viewer: 'viewer' | 'otherViewer' | 'anonymous' = 'viewer'
) {
  const token = viewer === 'anonymous' ? undefined : fx.tokens.get(viewer);
  if (viewer !== 'anonymous' && !token)
    throw new Error('Missing normal Steward fixture token');
  const response = await fetch(
    `${base}/api/posts?${new URLSearchParams(query)}`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }
  );
  expect(response.status).toBe(200);
  if (token) expect(response.headers.get('cache-control')).toContain('private');
  return responseSchema.parse(await response.json());
}
async function traverse(
  fx: Fixture,
  limit: number,
  query: Record<string, string> = { cursor: fx.anchor },
  viewer: 'viewer' | 'otherViewer' | 'anonymous' = 'viewer'
) {
  const result: string[] = [];
  let cursor = query.cursor;
  for (let number = 0; number < 12; number++) {
    const current = await page(
      fx,
      { ...query, limit: String(limit), ...(cursor ? { cursor } : {}) },
      viewer
    );
    result.push(...current.posts.map((row) => row.id));
    if (!current.hasMore) {
      expect(new Set(result).size).toBe(result.length);
      return result;
    }
    expect(current.cursor).not.toBeNull();
    expect(current.cursor).not.toBe(cursor);
    cursor = current.cursor ?? undefined;
  }
  throw new Error('Bounded feed traversal did not terminate');
}
async function withFixture(
  specs: PostSpec[],
  run: (fx: Fixture) => Promise<void>
) {
  const fx = await seed(specs);
  try {
    await run(fx);
  } finally {
    await cleanup(fx.rows);
  }
}

describe('GET /api/posts paging over posts hidden from the viewer', () => {
  it('reaches every visible post when hidden authors hold the first page', async () => {
    await withFixture(
      [
        { label: 'hidden1', author: 'blocked', offset: '10' },
        { label: 'hidden2', author: 'muted', offset: '20' },
        { label: 'hidden3', author: 'blocker', offset: '25' },
        ...[30, 40, 50, 60, 70].map((offset) => ({
          label: `visible${offset}`,
          offset: String(offset),
        })),
      ],
      async (fx) => {
        expect(await traverse(fx, 3)).toEqual(
          [30, 40, 50, 60, 70].map((offset) => post(fx, `visible${offset}`))
        );
      }
    );
  });
  it('reaches posts past a page shortened by a hidden author mid-feed', async () => {
    await withFixture(
      [
        { label: 'first', offset: '10' },
        { label: 'second', offset: '20' },
        { label: 'hidden', author: 'blocked', offset: '30' },
        ...[40, 50, 60].map((offset) => ({
          label: `visible${offset}`,
          offset: String(offset),
        })),
      ],
      async (fx) => {
        expect(await traverse(fx, 2)).toEqual(
          ['first', 'second', 'visible40', 'visible50', 'visible60'].map(
            (label) => post(fx, label)
          )
        );
      }
    );
  });
  it('keeps paging past a simple repost whose original was deleted, and still shows quote reposts', async () => {
    await withFixture(
      [
        { label: 'original', offset: '500', deleted: true },
        { label: 'dead', offset: '10', content: '', original: 'original' },
        {
          label: 'quote',
          offset: '15',
          content: 'my take on this',
          original: 'original',
        },
        ...[20, 30, 40, 50].map((offset) => ({
          label: `visible${offset}`,
          offset: String(offset),
        })),
      ],
      async (fx) => {
        const expected = [
          'quote',
          'visible20',
          'visible30',
          'visible40',
          'visible50',
        ].map((label) => post(fx, label));
        expect(await traverse(fx, 2)).toEqual(expected);
        expect(await traverse(fx, 2, { type: fx.type })).toEqual(expected);
      }
    );
  });
  it('control: reaches every post exactly once when nothing is hidden', async () => {
    await withFixture(
      [300, 290, 280, 270, 260].map((offset) => ({
        label: `visible${offset}`,
        offset: String(offset),
      })),
      async (fx) => {
        expect(await traverse(fx, 2)).toEqual(
          [260, 270, 280, 290, 300].map((offset) =>
            post(fx, `visible${offset}`)
          )
        );
      }
    );
  });
  it('applies visibility before type-page limits and preserves unfiltered viewer and anonymous results', async () => {
    await withFixture(
      [
        { label: 'blocked', author: 'blocked', offset: '1' },
        { label: 'muted', author: 'muted', offset: '2' },
        { label: 'blocker', author: 'blocker', offset: '3' },
        { label: 'visible1', offset: '4' },
        { label: 'visible2', offset: '5' },
      ],
      async (fx) => {
        const visible = ['visible1', 'visible2'].map((label) =>
          post(fx, label)
        );
        const all = ['blocked', 'muted', 'blocker', 'visible1', 'visible2'].map(
          (label) => post(fx, label)
        );
        expect(await traverse(fx, 2, { type: fx.type })).toEqual(visible);
        expect(await traverse(fx, 2, { type: fx.type }, 'otherViewer')).toEqual(
          all
        );
        expect(await traverse(fx, 2, { type: fx.type }, 'anonymous')).toEqual(
          all
        );
        expect(await traverse(fx, 2, { type: fx.type })).toEqual(visible);
      }
    );
  });
  it('partitions actor pages by viewer in both request orders without cache clearing', async () => {
    await withFixture(
      [
        { label: 'one', author: 'blocked', offset: '1' },
        { label: 'two', author: 'blocked', offset: '2' },
        { label: 'three', author: 'blocked', offset: '3' },
      ],
      async (fx) => {
        const query = { actorId: user(fx, 'blocked') };
        const all = ['one', 'two', 'three'].map((label) => post(fx, label));
        expect(await traverse(fx, 2, query, 'anonymous')).toEqual(all);
        expect(await traverse(fx, 2, query)).toEqual([]);
        expect(await traverse(fx, 2, query, 'otherViewer')).toEqual(all);
        expect(await traverse(fx, 2, query)).toEqual([]);
        expect(await traverse(fx, 2, query, 'anonymous')).toEqual(all);
      }
    );
  });
  it('retains exact tied and neighboring microsecond cursor positions through filtered pages', async () => {
    await withFixture(
      [
        { label: 'old', offset: '3.123789' },
        { label: 'tie1', offset: '3.123456' },
        { label: 'hidden', author: 'blocked', offset: '3.123456' },
        { label: 'tie2', offset: '3.123456' },
        { label: 'new', offset: '3.123001' },
      ],
      async (fx) => {
        const expected = [
          post(fx, 'new'),
          ...['tie1', 'tie2']
            .map((label) => post(fx, label))
            .sort()
            .reverse(),
          post(fx, 'old'),
        ];
        for (const limit of [1, 2])
          expect(await traverse(fx, limit)).toEqual(expected);
        expect(await traverse(fx, 1, { actorId: user(fx, 'author') })).toEqual(
          expected
        );
      }
    );
  });
  it('keeps raw cursor delimiters separate from the viewer policy after anonymous priming', async () => {
    const fx = await seed(
      [
        { label: 'anchor', offset: '0' },
        { label: 'hidden', author: 'blocked', offset: '1' },
        { label: 'one', offset: '2' },
        { label: 'two', offset: '3' },
        { label: 'three', offset: '4' },
      ],
      true
    );
    try {
      const [anchor] = await control<
        { stamp: string }[]
      >`SELECT to_char(timestamp,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM "Post" WHERE id=${post(fx, 'anchor')}`;
      if (!anchor) throw new Error('Missing acquired cursor anchor');
      const cursor = `${anchor.stamp}_${post(fx, 'anchor')}`;
      // The nonexistent suffixed ID legitimately falls back to this timestamp.
      const primed = await page(
        fx,
        { cursor: `${cursor}:excl:${user(fx, 'blocked')}`, limit: '2' },
        'anonymous'
      );
      expect(primed.posts.map((row) => row.id)).toEqual(
        ['hidden', 'one'].map((label) => post(fx, label))
      );
      expect(await traverse(fx, 2, { cursor })).toEqual(
        ['one', 'two', 'three'].map((label) => post(fx, label))
      );
      // This proves HTTP outcomes; it does not infer that an app-cache hit occurred.
    } finally {
      await cleanup(fx.rows);
    }
  });
  it('does not acquire a failed setup and refuses a separately owned reaction or User drift without partial deletion', async () => {
    await withFixture([{ label: 'owned', offset: '1' }], async (fx) => {
      const original = await physical(fx.rows),
        failed: Receipt[] = [],
        value = await fresh();
      await expect(
        control.begin(async (tx) => {
          await insert(
            tx,
            failed,
            'User',
            'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
            [value, `p1712_${value}`]
          );
          await insert(
            tx,
            failed,
            'User',
            'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
            [user(fx, 'viewer'), `p1712_collision_${value}`]
          );
        })
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
      expect(
        await control`SELECT id FROM "User" WHERE id=${value}`
      ).toHaveLength(0);
      expect(await physical(fx.rows)).toEqual(original);
      const pending: Receipt[] = [],
        foreign: Receipt[] = [];
      await control.begin(async (tx) => {
        await insert(
          tx,
          pending,
          'Reaction',
          'INSERT INTO "Reaction"(id,"postId","userId") VALUES($1,$2,$3)',
          [await fresh(), post(fx, 'owned'), user(fx, 'otherViewer')]
        );
      });
      foreign.push(...pending);
      fixtures.push(foreign);
      const foreignBefore = await physical(foreign);
      try {
        await expect(cleanup(fx.rows)).rejects.toThrow(
          'Owned cleanup refused Post'
        );
        expect(await physical(fx.rows)).toEqual(original);
        expect(await physical(foreign)).toEqual(foreignBefore);
      } finally {
        await cleanup(foreign);
      }
      const receipt = fx.rows.find(
        (row) => row.table === 'User' && row.id === user(fx, 'viewer')
      );
      if (!receipt) throw new Error('Missing owned User receipt');
      const changed = await control<
        Physical[]
      >`UPDATE "User" t SET bio='p1712 unrelated drift' WHERE id=${receipt.id} AND to_jsonb(t)=${receipt.canonical}::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical`;
      expect(changed).toHaveLength(1);
      try {
        await expect(cleanup(fx.rows)).rejects.toThrow(
          'Owned cleanup refused User'
        );
        expect(
          await physical(fx.rows.filter((row) => row.id !== receipt.id))
        ).toEqual(original.filter((row) => row.id !== receipt.id));
      } finally {
        const drift = changed[0];
        if (!drift) throw new Error('Missing drift receipt');
        expect(
          await control`UPDATE "User" t SET bio=(${receipt.canonical}::text::jsonb->>'bio') WHERE id=${receipt.id} AND to_jsonb(t)=${drift.canonical}::text::jsonb RETURNING id`
        ).toHaveLength(1);
      }
    });
  });
});
