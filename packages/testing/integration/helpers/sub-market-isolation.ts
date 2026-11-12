/**
 * Dedicated process/database lease for the four global sub-market-cap cases.
 * The caller's database may contain real cron output; never reset or edit it.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

const ROOT = resolve(import.meta.dir, '../../../..');
const FILE =
  'packages/testing/integration/sub-market-write.integration.test.ts';
const CASES = [
  'concurrent writers serialize the last available slot',
  'rechecks an inactive parent after waiting for the cap lock',
  'rechecks an expired parent after waiting for the cap lock',
  'rolls back question and prediction market if the final insert fails',
];
type Lease = {
  database: string;
  oid: string;
  owner: string;
  role: string;
  server: string;
  port: number;
  started: string;
  nonce: string;
};
function requireThat(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
function localUrl(raw: string | undefined, isolated = false) {
  requireThat(!!raw, 'Explicit local database URL required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid local database URL');
  }
  requireThat(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['5432', '5433', '55685'].includes(url.port || '5432') &&
      !url.search &&
      !url.hash &&
      ['postgres', 'symbiex', 'feed'].includes(
        decodeURIComponent(url.username)
      ) &&
      (isolated ? /^\/feed_pr\d{20,40}$/ : /^\/(?:test_db|feed_pr\d+)$/).test(
        url.pathname
      ),
    'Only an explicit disposable local database is supported'
  );
  return url;
}
function client(url: string) {
  return postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    connection: { statement_timeout: 10000, lock_timeout: 1000 },
    onnotice: () => {},
  });
}
async function identity(db: ReturnType<typeof postgres>) {
  const [row] = await db.unsafe<
    {
      database: string;
      role: string;
      roleOid: string;
      session: string;
      server: string;
      port: number;
      started: string;
      replica: boolean;
    }[]
  >(
    'SELECT current_database() AS database,current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "roleOid",session_user AS session,' +
      'pg_catalog.host(inet_server_addr()) AS server,inet_server_port() AS port,' +
      'extract(epoch from pg_postmaster_start_time())::text AS started,pg_is_in_recovery() AS replica'
  );
  requireThat(
    !!row && !row.replica && row.role === row.session,
    'Local primary role identity required'
  );
  return row;
}
function verifyParentBackend(
  source: URL,
  actual: Awaited<ReturnType<typeof identity>>
) {
  const localBackend = ['127.0.0.1', '::1'].includes(actual.server);
  const exactJobService =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    source.hostname === 'localhost' &&
    source.port === '5432' &&
    source.pathname === '/test_db' &&
    source.username === 'postgres' &&
    actual.database === 'test_db' &&
    actual.role === 'postgres' &&
    actual.session === 'postgres' &&
    actual.port === 5432 &&
    !!process.env.FEED_TEST_POSTGRES_ADDRESS &&
    actual.server === process.env.FEED_TEST_POSTGRES_ADDRESS;
  requireThat(
    actual.port === Number(source.port || '5432') &&
      (localBackend || exactJobService),
    'Actual PostgreSQL backend must be loopback or the exact GitHub job service'
  );
}
async function leaseRow(db: ReturnType<typeof postgres>, name: string) {
  const [row] = await db.unsafe<
    { oid: string; owner: string; nonce: string }[]
  >(
    "SELECT oid::text AS oid,datdba::text AS owner,pg_catalog.shobj_description(oid,'pg_database') AS nonce FROM pg_catalog.pg_database WHERE datname=$1",
    [name]
  );
  return row;
}
function persist(path: string, value: object) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function verifySubMarketChildLease() {
  const nonce = process.env.FEED_SUB_MARKET_CHILD;
  const path = process.env.FEED_SUB_MARKET_LEASE_FILE;
  requireThat(
    !!nonce && /^[a-f0-9-]{36}$/.test(nonce) && !!path,
    'Verified child lease required'
  );
  const meta = lstatSync(path, { throwIfNoEntry: false });
  requireThat(
    !!meta &&
      meta.isFile() &&
      (meta.mode & 0o777) === 0o600 &&
      meta.uid === process.getuid?.() &&
      meta.nlink === 1,
    'Private child lease required'
  );
  const lease = JSON.parse(readFileSync(path, 'utf8')) as Lease;
  const url = localUrl(process.env.DATABASE_URL, true);
  requireThat(
    url.href === process.env.DIRECT_DATABASE_URL &&
      !process.env.DATABASE_READ_REPLICA_URL &&
      lease.nonce === nonce &&
      url.pathname === '/' + lease.database &&
      decodeURIComponent(url.username) === lease.role,
    'Child URL does not match its lease'
  );
  const db = client(url.href);
  try {
    const actual = await identity(db);
    const row = await leaseRow(db, lease.database);
    requireThat(
      actual.database === lease.database &&
        actual.role === lease.role &&
        actual.server === lease.server &&
        actual.port === lease.port &&
        actual.started === lease.started &&
        row?.oid === lease.oid &&
        row.owner === lease.owner &&
        row.nonce === nonce,
      'Child database lease changed'
    );
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
  timeout: number
) {
  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let size = 0,
    expired = false,
    overBudget = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (proc.pid && !killTimer) {
      const group = proc.pid;
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-group, signal);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ESRCH'
          )
            throw error;
        }
      };
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 3000);
    }
  };
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, timeout);
  const drain = (part: Buffer) => {
    size += part.length;
    if (size > 4 * 1024 * 1024) {
      overBudget = true;
      stop();
    } else chunks.push(part);
  };
  proc.stdout.on('data', drain);
  proc.stderr.on('data', drain);
  try {
    const code = await new Promise<number>((done, reject) => {
      proc.once('error', reject);
      proc.once('close', (exit) => done(exit ?? 1));
    });
    const output = Buffer.concat(chunks).toString('utf8');
    writeFileSync(log, output, { mode: 0o600 });
    if (proc.pid) {
      let absent = false;
      try {
        process.kill(-proc.pid, 0);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ESRCH'
        )
          throw error;
        absent = true;
      }
      if (!absent) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ESRCH'
          )
            throw error;
        }
        throw new Error(
          'Isolated process group survived; database and logs retained'
        );
      }
    }
    requireThat(
      !expired && !overBudget,
      'Isolated process exceeded its time/output bound'
    );
    requireThat(
      code === 0,
      'Isolated process failed; retained private log: ' + log
    );
    return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

export async function runIsolatedSubMarketCases() {
  requireThat(
    !process.env.FEED_SUB_MARKET_CHILD &&
      !process.env.FEED_SUB_MARKET_LEASE_FILE,
    'Parent cannot reuse a child marker'
  );
  const source = localUrl(process.env.DATABASE_URL);
  requireThat(
    (!process.env.DIRECT_DATABASE_URL ||
      source.href === process.env.DIRECT_DATABASE_URL) &&
      !process.env.DATABASE_READ_REPLICA_URL,
    'One local primary URL required'
  );
  const admin = client(source.href);
  const directory = mkdtempSync(join(tmpdir(), 'feed-sub-market-'));
  const manifest = join(directory, 'lease.json');
  const resultPath = join(directory, 'result.json');
  const nonce = randomUUID();
  const database =
    'feed_pr' + BigInt('0x' + nonce.replaceAll('-', '')).toString();
  let lease: Lease | undefined;
  let created = false;
  let creationAttempted = false;
  let phase = 'identity';
  let passed = false;
  let childProof: object | undefined;
  try {
    const parent = await identity(admin);
    requireThat(
      parent.database === decodeURIComponent(source.pathname.slice(1)) &&
        parent.role === decodeURIComponent(source.username),
      'Parent database role mismatch'
    );
    verifyParentBackend(source, parent);
    phase = 'create-database';
    creationAttempted = true;
    await admin.unsafe('CREATE DATABASE "' + database + '"');
    created = true;
    persist(manifest, {
      database,
      nonce,
      role: parent.role,
      phase: 'created-awaiting-oid',
    });
    // No IF NOT EXISTS: a collision never establishes ownership.
    const acquired = await leaseRow(admin, database);
    requireThat(
      !!acquired &&
        /^[1-9]\d*$/.test(acquired.oid) &&
        /^[1-9]\d*$/.test(acquired.owner) &&
        acquired.owner === parent.roleOid,
      'Created database has no positive OID lease'
    );
    lease = {
      database,
      oid: acquired.oid,
      owner: acquired.owner,
      role: parent.role,
      server: parent.server,
      port: parent.port,
      started: parent.started,
      nonce,
    };
    persist(manifest, lease);
    await admin.unsafe(
      'COMMENT ON DATABASE "' + database + '" IS \'' + nonce + "'"
    );
    const child = new URL(source.href);
    child.pathname = '/' + database;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: child.href,
      DIRECT_DATABASE_URL: child.href,
      DATABASE_READ_REPLICA_URL: '',
      DATABASE_POOL_MAX: '5',
      NODE_ENV: 'test',
      BUN_ENV: 'test',
      FEED_SUB_MARKET_CHILD: nonce,
      FEED_SUB_MARKET_LEASE_FILE: manifest,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    };
    phase = 'migrate';
    await run(
      ['run', 'db:migrate'],
      env,
      join(directory, 'migrate.log'),
      60000
    );
    phase = 'four-child-cases';
    const output = await run(
      ['test', FILE, '--timeout', '30000'],
      env,
      join(directory, 'child.log'),
      120000
    );
    const escape = (text: string) =>
      text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');
    const lines = output.split('\n');
    const passes = CASES.map((name) =>
      lines.find((line) =>
        new RegExp(
          '^\\(pass\\) sub-market transactional creation > ' +
            escape(name) +
            '(?: \\[|\\r?$)'
        ).test(line)
      )
    );
    requireThat(
      passes.every((line) => !!line) &&
        /^\s*4 pass\r?$/m.test(output) &&
        /^\s*0 fail\r?$/m.test(output) &&
        !/^\s*[1-9]\d* skip\r?$/m.test(output) &&
        /Ran 4 tests across 1 file\./.test(output),
      'All four original cases must pass without skips'
    );
    childProof = {
      pass: 4,
      skip: 0,
      fail: 0,
      cases: CASES,
      childLog: join(directory, 'child.log'),
    };
    for (const line of passes) console.info('[isolated child] ' + line);
    phase = 'drain-and-drop';
    const actual = await identity(admin);
    const current = await leaseRow(admin, database);
    const [connections] = await admin.unsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid',
      [lease.oid]
    );
    requireThat(
      actual.started === lease.started &&
        actual.server === lease.server &&
        actual.port === lease.port &&
        actual.role === lease.role &&
        current?.oid === lease.oid &&
        current.owner === lease.owner &&
        current.nonce === nonce &&
        connections?.count === 0,
      'Retain changed or connected child database'
    );
    await admin.unsafe('DROP DATABASE "' + database + '"'); // Never FORCE or terminate another connection.
    requireThat(
      !(await leaseRow(admin, database)),
      'Owned database drop not confirmed'
    );
    passed = true;
    persist(resultPath, {
      status: 'PASS_ISOLATED_FOUR_SUB_MARKET_CASES',
      lease,
      childProof,
      databaseDropped: true,
      sourceDatabaseRowsNeverWritten: true,
      parentEnvironmentUnchanged: true,
    });
    console.info(
      'ISOLATED_SUB_MARKET_RESULT ' +
        JSON.stringify({
          pass: 4,
          skip: 0,
          fail: 0,
          database,
          databaseDropped: true,
          result: resultPath,
        })
    );
  } finally {
    if (!passed) {
      persist(resultPath, {
        status: 'HOLD_ISOLATED_SUB_MARKET_CASES',
        phase,
        lease,
        childProof,
        database,
        databaseRetained: created
          ? true
          : creationAttempted
            ? 'unknown'
            : false,
        noAutomaticRetryOrSharedCleanup: true,
      });
      console.error(
        'ISOLATED_SUB_MARKET_HOLD ' +
          JSON.stringify({ phase, result: resultPath })
      );
    }
    await admin.end({ timeout: 5 });
  }
}
