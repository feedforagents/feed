/**
 * Dedicated process/database leases for fixed integration suites.
 * The caller's database may contain real cron output; never reset or edit it.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const PREDICTION_FILE =
  'packages/testing/integration/prediction-share-remainder.integration.test.ts';
const PREDICTION_CASES = ['yes', 'no'].flatMap((side) =>
  ['cent', 'above', 'dust', 'whole', 'loser'].map(
    (scenario) =>
      `${side} ${scenario} funded remainder sells and settles through real HTTP`
  )
);
const PLUGIN_PERP_FILE =
  'packages/testing/integration/perp-open-fee-durability.integration.test.ts';
const PLUGIN_PERP_CASES = [
  'long: transient fee failure has completed or queued fee work before open returns',
  'long: persistent fee failure has completed or queued fee work before open returns',
  'short: transient fee failure has completed or queued fee work before open returns',
  'short: persistent fee failure has completed or queued fee work before open returns',
  'plugin OPEN and CLOSE return with actual keyed fee accounting and no referral payment',
  'plugin OPEN and CLOSE return success with their own durable fee intents during an outage',
];
type Suite = 'sub-market' | 'prediction-remainder' | 'plugin-perp-fee';
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

async function verifyChildLease(
  nonce: string | undefined,
  path: string | undefined
) {
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

export async function verifySubMarketChildLease() {
  await verifyChildLease(
    process.env.FEED_SUB_MARKET_CHILD,
    process.env.FEED_SUB_MARKET_LEASE_FILE
  );
}

export async function verifyPredictionRemainderChildLease() {
  await verifyChildLease(
    process.env.FEED_PREDICTION_REMAINDER_CHILD,
    process.env.FEED_PREDICTION_REMAINDER_LEASE_FILE
  );
}

export async function verifyPluginPerpFeeChildLease() {
  await verifyChildLease(
    process.env.FEED_PLUGIN_PERP_FEE_CHILD,
    process.env.FEED_PLUGIN_PERP_FEE_LEASE_FILE
  );
}

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
  timeout: number,
  executable = process.execPath
) {
  const proc = spawn(executable, args, {
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

export async function startPredictionRemainderServer() {
  await verifyPredictionRemainderChildLease();
  const env = process.env;
  const directory = dirname(env.FEED_PREDICTION_REMAINDER_LEASE_FILE!);
  const app = join(ROOT, 'apps/web');
  const buildIdPath = join(app, '.next/BUILD_ID');
  const buildId = readFileSync(buildIdPath, 'utf8').trim();
  requireThat(buildId.length > 0, 'An existing production build is required');
  const port = await new Promise<number>((done, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('Loopback port reservation failed'));
        return;
      }
      reservation.close((error) =>
        error ? reject(error) : done(address.port)
      );
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const runtimeEnv = {
    ...env,
    PORT: String(port),
    FEED_API_URL: url,
    TEST_API_URL: url,
    TEST_BASE_URL: url,
  };
  const next = createRequire(join(app, 'package.json')).resolve(
    'next/dist/bin/next'
  );
  const log = join(directory, 'server.log');
  const sink = createWriteStream(log, { flags: 'wx', mode: 0o600 });
  const proc = spawn(
    process.execPath,
    [next, 'start', app, '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: app, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let closed = false,
    output = '',
    size = 0,
    failure: Error | undefined;
  const exited = new Promise<void>((done) =>
    proc.once('close', () => {
      closed = true;
      done();
    })
  );
  proc.once('error', (error) => {
    failure = error;
  });
  sink.once('error', (error) => {
    failure = error;
  });
  const capture = (part: Buffer) => {
    size += part.length;
    if (size > 4 * 1024 * 1024) {
      failure = new Error('Owned server log exceeded its bound');
      return;
    }
    output += part.toString('utf8');
    sink.write(part);
  };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  const stop = async () => {
    let forced = false,
      requestedStop = false;
    if (!closed) {
      requestedStop = proc.kill('SIGTERM');
      await Promise.race([exited, Bun.sleep(5000)]);
      if (!closed) {
        forced = true;
        proc.kill('SIGKILL');
        await Promise.race([exited, Bun.sleep(3000)]);
      }
    }
    await new Promise<void>((done) => sink.end(done));
    const buildIdUnchanged =
      readFileSync(buildIdPath, 'utf8').trim() === buildId;
    const normalExit =
      proc.exitCode === 0 ||
      proc.exitCode === 143 ||
      proc.signalCode === 'SIGTERM';
    persist(join(directory, 'server-stopped.json'), {
      pid: proc.pid,
      childProcessGroup: process.pid,
      url,
      buildId,
      forced,
      serverExited: closed,
      exitCode: proc.exitCode,
      signalCode: proc.signalCode,
      requestedStop,
      normalExit,
      failureClass: failure?.name ?? null,
      buildIdUnchanged,
    });
    // This server inherits the leased child's group. The parent run() also
    // requires the entire group to be absent before it can retire the database.
    requireThat(
      closed &&
        requestedStop &&
        normalExit &&
        !forced &&
        !failure &&
        buildIdUnchanged,
      'Owned server did not drain normally or build changed; retain database'
    );
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      requireThat(
        !closed && !failure,
        'Owned production server exited; retained log: ' + log
      );
      if (output.includes(url) && output.includes('Ready in')) {
        try {
          const response = await fetch(url + '/api/health', {
            redirect: 'error',
            signal: AbortSignal.timeout(2000),
          });
          await response.body?.cancel();
          if (response.status === 200) {
            persist(join(directory, 'server-ready.json'), {
              pid: proc.pid,
              childProcessGroup: process.pid,
              url,
              buildId,
              app,
              log,
              database: new URL(env.DATABASE_URL!).pathname.slice(1),
              healthStatus: 200,
            });
            return { url, stop };
          }
        } catch (error) {
          if (
            !(error instanceof TypeError) &&
            !(error instanceof DOMException && error.name === 'TimeoutError')
          )
            throw error;
        }
      }
      await Bun.sleep(25);
    }
    throw new Error(
      'Owned production server did not become healthy; retained log: ' + log
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function runIsolatedSubMarketCases() {
  await runIsolatedCases('sub-market');
}

export async function runIsolatedPredictionRemainderCases() {
  await runIsolatedCases('prediction-remainder');
}

export async function runIsolatedPluginPerpFeeCases() {
  await runIsolatedCases('plugin-perp-fee');
}

async function runIsolatedCases(suite: Suite) {
  const prediction = suite === 'prediction-remainder';
  const plugin = suite === 'plugin-perp-fee';
  const file = plugin ? PLUGIN_PERP_FILE : prediction ? PREDICTION_FILE : FILE;
  const cases = plugin
    ? PLUGIN_PERP_CASES
    : prediction
      ? PREDICTION_CASES
      : CASES;
  const marker = plugin
    ? 'FEED_PLUGIN_PERP_FEE_CHILD'
    : prediction
      ? 'FEED_PREDICTION_REMAINDER_CHILD'
      : 'FEED_SUB_MARKET_CHILD';
  const leaseVariable = plugin
    ? 'FEED_PLUGIN_PERP_FEE_LEASE_FILE'
    : prediction
      ? 'FEED_PREDICTION_REMAINDER_LEASE_FILE'
      : 'FEED_SUB_MARKET_LEASE_FILE';
  requireThat(
    !process.env.FEED_SUB_MARKET_CHILD &&
      !process.env.FEED_SUB_MARKET_LEASE_FILE &&
      !process.env.FEED_PREDICTION_REMAINDER_CHILD &&
      !process.env.FEED_PREDICTION_REMAINDER_LEASE_FILE &&
      !process.env.FEED_PLUGIN_PERP_FEE_CHILD &&
      !process.env.FEED_PLUGIN_PERP_FEE_LEASE_FILE,
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
  const directory = mkdtempSync(
    join(
      tmpdir(),
      plugin
        ? 'feed-plugin-perp-fee-'
        : prediction
          ? 'feed-prediction-remainder-'
          : 'feed-sub-market-'
    )
  );
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
      [marker]: nonce,
      [leaseVariable]: manifest,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    };
    phase = 'migrate';
    await run(
      ['run', 'db:migrate'],
      env,
      join(directory, 'migrate.log'),
      60000
    );
    if (prediction || plugin) {
      phase = 'manual-idempotency-index';
      const actual = await identity(admin);
      const current = await leaseRow(admin, database);
      requireThat(
        actual.started === lease.started &&
          actual.server === lease.server &&
          actual.port === lease.port &&
          actual.role === lease.role &&
          current?.oid === lease.oid &&
          current.owner === lease.owner &&
          current.nonce === nonce,
        'Created database lease changed before index setup'
      );
      // psql executes this unchanged manual file outside a transaction. Its
      // own catalog checks reject any missing, invalid or wrong-shape index.
      const manualEnv: NodeJS.ProcessEnv = { ...env };
      delete manualEnv.PGSERVICE;
      delete manualEnv.PGSERVICEFILE;
      await run(
        [
          '-X',
          '--no-password',
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          join(
            ROOT,
            'packages/db/drizzle/migrations/manual/0005b_trading_fee_idempotency_key_idx_concurrently.sql'
          ),
        ],
        {
          ...manualEnv,
          PGHOST: child.hostname.replace(/^\[|\]$/g, ''),
          PGPORT: child.port || '5432',
          PGUSER: decodeURIComponent(child.username),
          PGPASSWORD: decodeURIComponent(child.password),
          PGDATABASE: database,
          PGHOSTADDR: '',
          PGPASSFILE: '/dev/null',
          PGSSLMODE: 'disable',
          PGSSLROOTCERT: '',
          PGSSLCERT: '',
          PGSSLKEY: '',
          PGOPTIONS:
            '-c statement_timeout=10000 -c lock_timeout=1000 -c search_path=pg_catalog,public',
        },
        join(directory, 'manual-index.log'),
        60000,
        'psql'
      );
    }
    phase = plugin
      ? 'six-child-cases'
      : prediction
        ? 'ten-child-cases'
        : 'four-child-cases';
    const output = await run(
      ['test', file, '--timeout', '30000'],
      env,
      join(directory, 'child.log'),
      120000
    );
    const escape = (text: string) =>
      text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');
    const lines = output.split('\n');
    const passes = cases.map((name) =>
      lines.find((line) =>
        new RegExp(
          '^\\(pass\\) ' +
            (prediction || plugin
              ? ''
              : 'sub-market transactional creation > ') +
            escape(name) +
            '(?: \\[|\\r?$)'
        ).test(line)
      )
    );
    requireThat(
      passes.every((line) => !!line) &&
        new RegExp('^\\s*' + cases.length + ' pass\\r?$', 'm').test(output) &&
        /^\s*0 fail\r?$/m.test(output) &&
        !/^\s*[1-9]\d* skip\r?$/m.test(output) &&
        output.includes('Ran ' + cases.length + ' tests across 1 file.'),
      plugin
        ? 'All six real perp fee cases must pass without skips'
        : prediction
          ? 'All ten real HTTP cases must pass without skips'
          : 'All four original cases must pass without skips'
    );
    childProof = {
      pass: cases.length,
      skip: 0,
      fail: 0,
      cases,
      childLog: join(directory, 'child.log'),
    };
    for (const line of passes) console.info('[isolated child] ' + line);
    phase = 'drain-and-drop';
    const drainStarted = performance.now();
    const drainDeadline = drainStarted + 5000;
    const observations: object[] = [];
    let actual: Awaited<ReturnType<typeof identity>>;
    let current: Awaited<ReturnType<typeof leaseRow>>;
    let connections: { count: number } | undefined;
    for (;;) {
      actual = await identity(admin);
      current = await leaseRow(admin, database);
      [connections] = await admin.unsafe<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid',
        [lease.oid]
      );
      const clauses = {
        startedMatches: actual.started === lease.started,
        serverMatches: actual.server === lease.server,
        portMatches: actual.port === lease.port,
        roleMatches: actual.role === lease.role,
        oidMatches: current?.oid === lease.oid,
        ownerMatches: current?.owner === lease.owner,
        nonceMatches: current?.nonce === nonce,
        zeroConnections: connections?.count === 0,
      };
      observations.push({
        observedAtUtc: new Date().toISOString(),
        elapsedMilliseconds: performance.now() - drainStarted,
        actual,
        current: current ?? null,
        connections: connections ?? null,
        types: {
          started: typeof actual.started,
          server: typeof actual.server,
          port: typeof actual.port,
          role: typeof actual.role,
          oid: typeof current?.oid,
          owner: typeof current?.owner,
          nonce: typeof current?.nonce,
          connectionCount: typeof connections?.count,
        },
        clauses,
      });
      const unchangedLease =
        clauses.startedMatches &&
        clauses.serverMatches &&
        clauses.portMatches &&
        clauses.roleMatches &&
        clauses.oidMatches &&
        clauses.ownerMatches &&
        clauses.nonceMatches;
      const remaining = drainDeadline - performance.now();
      if (
        !unchangedLease ||
        !connections ||
        !Number.isInteger(connections.count) ||
        connections.count <= 0 ||
        remaining <= 0
      ) {
        persist(join(directory, 'drain-guard-observations.json'), {
          lease,
          maximumWaitMilliseconds: 5000,
          observations,
        });
        break;
      }
      // Client socket close can precede the server backend leaving pg_stat_activity.
      await Bun.sleep(Math.min(25, remaining));
    }
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
      status: plugin
        ? 'PASS_ISOLATED_SIX_PLUGIN_PERP_FEE_CASES'
        : prediction
          ? 'PASS_ISOLATED_TEN_PREDICTION_REMAINDER_CASES'
          : 'PASS_ISOLATED_FOUR_SUB_MARKET_CASES',
      lease,
      childProof,
      databaseDropped: true,
      sourceDatabaseRowsNeverWritten: true,
      parentEnvironmentUnchanged: true,
    });
    console.info(
      (plugin
        ? 'ISOLATED_PLUGIN_PERP_FEE_RESULT '
        : prediction
          ? 'ISOLATED_PREDICTION_REMAINDER_RESULT '
          : 'ISOLATED_SUB_MARKET_RESULT ') +
        JSON.stringify({
          pass: cases.length,
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
        status: plugin
          ? 'HOLD_ISOLATED_PLUGIN_PERP_FEE_CASES'
          : prediction
            ? 'HOLD_ISOLATED_PREDICTION_REMAINDER_CASES'
            : 'HOLD_ISOLATED_SUB_MARKET_CASES',
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
        (plugin
          ? 'ISOLATED_PLUGIN_PERP_FEE_HOLD '
          : prediction
            ? 'ISOLATED_PREDICTION_REMAINDER_HOLD '
            : 'ISOLATED_SUB_MARKET_HOLD ') +
          JSON.stringify({ phase, result: resultPath })
      );
    }
    await admin.end({ timeout: 5 });
  }
}
