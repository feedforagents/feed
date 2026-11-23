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
const PREDICTION_FEE_FILE =
  'packages/testing/integration/prediction-fee-partition.integration.test.ts';
const PREDICTION_FEE_CASES = [
  'prediction fee partition invariance (real DB) > seeded legacy subcent perp full close reconciles quote charge ledger and cash',
  'prediction fee partition invariance (real DB) > a split sell never credits more than the whole sell, and fees reconcile',
  'prediction fee partition invariance (real DB) > a split buy never receives more shares than the whole buy',
  'prediction fee partition invariance (real DB) > small sell legs at the rounding threshold each pay and record one cent',
  'prediction fee partition invariance (real DB) > repeated split round-trips stay reconciled and never beat whole execution',
  'prediction fee partition invariance (real DB) > dust proceeds settle to zero with no fee; a one-cent settled sell nets zero after its fee',
  'prediction fee partition invariance (real DB) > atomic fixture collisions preserve existing rows and leave no partial setup',
];
const NPC_TRADE_FILE =
  'packages/testing/integration/prediction-detail-trade-count.integration.test.ts';
const NPC_TRADE_CASES = [
  'prediction market detail tradeCount (all NPC execution paths) > counts an autonomous-loop NPC buy (executeDirectTrade)',
  'prediction market detail tradeCount (all NPC execution paths) > counts an autonomous-loop NPC sell (executeDirectTrade)',
  'prediction market detail tradeCount (all NPC execution paths) > counts a TradeExecutionService NPC buy exactly once (control)',
  'prediction market detail tradeCount (all NPC execution paths) > lists every executed trade in the market trades feed',
  'prediction market detail tradeCount (all NPC execution paths) > a failed sell creates no phantom mirror or wallet change',
  'prediction market detail tradeCount (all NPC execution paths) > invalidates a same-process feed cached while its mirror insert waits',
];
const MARKETS_REVIEW_FILE =
  'packages/testing/integration/markets-tick-review-hold.integration.test.ts';
const MARKETS_REVIEW_CASES = [
  'markets-tick manual resolution review > funded reviews stay held across ticks until approval; rejection postpones payment',
  'markets-tick manual resolution review > a losing admin resolver preserves the paid outcome and writes no audit',
];
const BALANCE_DISPLAY_FILE =
  'packages/testing/integration/balance-display-consistency.integration.test.ts';
const BALANCE_DISPLAY_CASES = [
  'balance display path vs wallet ledger > a settlement-style credit is visible on the cached display path immediately',
  'balance display path vs wallet ledger > a buy-style debit is visible on the cached display path immediately',
  'balance display path vs wallet ledger > guard: an untouched user reads the same balance on both paths',
  'balance display path vs wallet ledger > guard: explicit cache invalidation still refreshes the display path',
  'balance display path vs wallet ledger > control: a wallet mutation leaves unrelated follow/feed cache entries alone',
];
const CLOSED_PREDICTION_POSITIONS_FILE =
  'packages/testing/integration/closed-prediction-positions-list.integration.test.ts';
const CLOSED_PREDICTION_POSITIONS_CASES = [
  'user positions list — closed prediction positions > closed view lists positions closed by selling, not only resolved ones',
  'user positions list — closed prediction positions > status=all also includes sell-closed positions',
  'user positions list — closed prediction positions > open view still shows only the held position (guard)',
  'user positions list — closed prediction positions > closed perp positions still listed (guard)',
  'user positions list — closed prediction positions > a position sold through the real trading service appears in the closed view',
  'user positions list — closed prediction positions > the mounted Closed Positions flow keeps the sell-closed row',
  'user positions list — closed prediction positions > a failed sell still leaves the bought position owned for cleanup',
  'user positions list — closed prediction positions > cleanup removes only rows this suite created',
];
const MCP_FEE_FILE =
  'packages/testing/integration/mcp-perp-fee-recovery.integration.test.ts';
const MCP_FEE_CASES = [
  'MCP perp fee recovery against real Postgres > open_position: a fee write that fails every retry is kept in the outbox and drains to the charged fee',
  'MCP perp fee recovery against real Postgres > open_position: a fee that commits but fails every retry is recorded once, also after the drain',
  'MCP perp fee recovery against real Postgres > close_position: a post-commit fee error recovers to one close fee',
];
const TRADE_HISTORY_FILE =
  'packages/testing/integration/trades-history-missing-types.integration.test.ts';
const TRADE_HISTORY_CASES = [
  'serves the persisted prediction and perp trade history over HTTP',
];
const PREDICTION_SCENARIO_FILE =
  'packages/testing/integration/prediction-market-scenario.integration.test.ts';
const PREDICTION_SCENARIO_CASES = [
  'keeps the recorded scenario across adapter and terminal HTTP reads',
];
const STATS_TOTAL_HOOTS_FILE =
  'packages/testing/integration/stats-total-hoots.integration.test.ts';
const STATS_TOTAL_HOOTS_CASES = [
  'Platform stats count only reachable posts > adds only the reachable fixture post to the platform total',
  'Platform stats count only reachable posts > still moves for content readers can see',
  'Platform stats count only reachable posts > follows moderation: publishing a scheduled post raises the total, removing one lowers it',
];
const STATS_ACTIVE_PLAYERS_FILE =
  'packages/testing/integration/stats-active-players.integration.test.ts';
const STATS_ACTIVE_PLAYERS_CASES = [
  'Platform stats count only eligible active players > counts only the eligible player among recent activity',
  'Platform stats count only eligible active players > unbanning a player raises the count, banning lowers it again',
  'Platform stats count only eligible active players > clearing the agent flag raises the count',
];
const CHAT_MENTION_FILE =
  'packages/testing/integration/chat-mention-participants.integration.test.ts';
const CHAT_MENTION_CASES = [
  'GET /api/chats/[id] participants as the mention source > marks departed participants inactive so mentions skip them',
  'GET /api/chats/[id] participants as the mention source > keeps departed senders listed with names for old messages',
  'GET /api/chats/[id] participants as the mention source > keeps every active member reachable behind a shared prefix',
];
type Suite =
  | 'prediction-market-scenario'
  | 'sub-market'
  | 'prediction-remainder'
  | 'plugin-perp-fee'
  | 'prediction-fee'
  | 'npc-trade-count'
  | 'markets-review'
  | 'balance-display'
  | 'closed-prediction-positions'
  | 'mcp-perp-fee'
  | 'trade-history'
  | 'stats-total-hoots'
  | 'stats-active-players'
  | 'chat-mentions';
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

export async function verifyPredictionFeeChildLease() {
  await verifyChildLease(
    process.env.FEED_PREDICTION_FEE_CHILD,
    process.env.FEED_PREDICTION_FEE_LEASE_FILE
  );
}

export async function verifyNpcTradeCountChildLease() {
  await verifyChildLease(
    process.env.FEED_NPC_TRADE_COUNT_CHILD,
    process.env.FEED_NPC_TRADE_COUNT_LEASE_FILE
  );
}

export async function verifyMarketsReviewChildLease() {
  await verifyChildLease(
    process.env.FEED_MARKETS_REVIEW_CHILD,
    process.env.FEED_MARKETS_REVIEW_LEASE_FILE
  );
}

export async function verifyBalanceDisplayChildLease() {
  await verifyChildLease(
    process.env.FEED_BALANCE_DISPLAY_CHILD,
    process.env.FEED_BALANCE_DISPLAY_LEASE_FILE
  );
}

export async function verifyClosedPredictionPositionsChildLease() {
  await verifyChildLease(
    process.env.FEED_CLOSED_PREDICTION_POSITIONS_CHILD,
    process.env.FEED_CLOSED_PREDICTION_POSITIONS_LEASE_FILE
  );
}

export async function verifyMcpPerpFeeChildLease() {
  await verifyChildLease(
    process.env.FEED_MCP_PERP_FEE_CHILD,
    process.env.FEED_MCP_PERP_FEE_LEASE_FILE
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
  return startOwnedPredictionServer(
    process.env.FEED_PREDICTION_REMAINDER_LEASE_FILE!,
    true
  );
}

export async function startNpcTradeCountServer() {
  await verifyNpcTradeCountChildLease();
  return startOwnedPredictionServer(
    process.env.FEED_NPC_TRADE_COUNT_LEASE_FILE!,
    false
  );
}

export async function startTradeHistoryServer() {
  await verifySubMarketChildLease();
  return startOwnedPredictionServer(
    process.env.FEED_SUB_MARKET_LEASE_FILE!,
    false
  );
}

async function startOwnedPredictionServer(
  leaseFile: string,
  testAuth: boolean
) {
  const env = process.env;
  const directory = dirname(leaseFile);
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
    ALLOW_TEST_PRIVY_DID_AUTH: testAuth ? 'true' : 'false',
    DISABLE_RATE_LIMITING: testAuth ? 'true' : 'false',
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

export async function runIsolatedSubMarketCases(fixture?: IsolatedFixture) {
  await runIsolatedCases('sub-market', fixture);
}

export async function runIsolatedPredictionRemainderCases() {
  await runIsolatedCases('prediction-remainder');
}

export async function runIsolatedPredictionMarketScenarioCase() {
  await runIsolatedCases('prediction-market-scenario');
}

export async function runIsolatedPluginPerpFeeCases() {
  await runIsolatedCases('plugin-perp-fee');
}

export async function runIsolatedPredictionFeeCases() {
  await runIsolatedCases('prediction-fee');
}

export async function runIsolatedNpcTradeCountCases() {
  await runIsolatedCases('npc-trade-count');
}

export async function runIsolatedMarketsReviewCases() {
  await runIsolatedCases('markets-review');
}

export async function runIsolatedBalanceDisplayCases() {
  await runIsolatedCases('balance-display');
}

export async function runIsolatedClosedPredictionPositionsCases(
  fixture?: IsolatedFixture
) {
  await runIsolatedCases('closed-prediction-positions', fixture);
}

export async function runIsolatedMcpPerpFeeCases(fixture?: IsolatedFixture) {
  await runIsolatedCases('mcp-perp-fee', fixture);
}

export async function runIsolatedTradeHistoryCase() {
  await runIsolatedCases('trade-history');
}

export async function runIsolatedStatsTotalHootsCases() {
  await runIsolatedCases('stats-total-hoots');
}

export async function runIsolatedStatsActivePlayersCases() {
  await runIsolatedCases('stats-active-players');
}

export async function runIsolatedChatMentionCases() {
  await runIsolatedCases('chat-mentions');
}

interface IsolatedFixture {
  name: string;
  file: string;
  cases: string[];
  manualTradingFeeIndex?: boolean;
}

async function runIsolatedCases(suite: Suite, fixture?: IsolatedFixture) {
  // Chat mentions, stats and trade history use the original child lease.
  const chatMentions = suite === 'chat-mentions';
  const stats = suite === 'stats-total-hoots';
  const activePlayers = suite === 'stats-active-players';
  const tradeHistory = suite === 'trade-history';
  const closedPositions = suite === 'closed-prediction-positions';
  const balance = suite === 'balance-display';
  const review = suite === 'markets-review';
  const npc = suite === 'npc-trade-count';
  const fee = suite === 'prediction-fee';
  const prediction = suite === 'prediction-remainder';
  const plugin = suite === 'plugin-perp-fee';
  const mcpFee = suite === 'mcp-perp-fee';
  const scenario = suite === 'prediction-market-scenario';
  const scenarioOrClosedPositions = scenario || closedPositions;
  const file = closedPositions
    ? CLOSED_PREDICTION_POSITIONS_FILE
    : balance
      ? BALANCE_DISPLAY_FILE
      : review
        ? MARKETS_REVIEW_FILE
        : npc
          ? NPC_TRADE_FILE
          : fee
            ? PREDICTION_FEE_FILE
            : plugin
              ? PLUGIN_PERP_FILE
              : prediction
                ? PREDICTION_FILE
                : mcpFee
                  ? MCP_FEE_FILE
                  : tradeHistory
                    ? TRADE_HISTORY_FILE
                    : stats
                      ? STATS_TOTAL_HOOTS_FILE
                      : activePlayers
                        ? STATS_ACTIVE_PLAYERS_FILE
                        : chatMentions
                          ? CHAT_MENTION_FILE
                          : FILE;
  const cases = closedPositions
    ? CLOSED_PREDICTION_POSITIONS_CASES
    : balance
      ? BALANCE_DISPLAY_CASES
      : review
        ? MARKETS_REVIEW_CASES
        : npc
          ? NPC_TRADE_CASES
          : fee
            ? PREDICTION_FEE_CASES
            : plugin
              ? PLUGIN_PERP_CASES
              : prediction
                ? PREDICTION_CASES
                : mcpFee
                  ? MCP_FEE_CASES
                  : tradeHistory
                    ? TRADE_HISTORY_CASES
                    : stats
                      ? STATS_TOTAL_HOOTS_CASES
                      : activePlayers
                        ? STATS_ACTIVE_PLAYERS_CASES
                        : chatMentions
                          ? CHAT_MENTION_CASES
                          : CASES;
  const marker = closedPositions
    ? 'FEED_CLOSED_PREDICTION_POSITIONS_CHILD'
    : balance
      ? 'FEED_BALANCE_DISPLAY_CHILD'
      : review
        ? 'FEED_MARKETS_REVIEW_CHILD'
        : npc
          ? 'FEED_NPC_TRADE_COUNT_CHILD'
          : fee
            ? 'FEED_PREDICTION_FEE_CHILD'
            : plugin
              ? 'FEED_PLUGIN_PERP_FEE_CHILD'
              : prediction
                ? 'FEED_PREDICTION_REMAINDER_CHILD'
                : mcpFee
                  ? 'FEED_MCP_PERP_FEE_CHILD'
                  : 'FEED_SUB_MARKET_CHILD';
  const leaseVariable = closedPositions
    ? 'FEED_CLOSED_PREDICTION_POSITIONS_LEASE_FILE'
    : balance
      ? 'FEED_BALANCE_DISPLAY_LEASE_FILE'
      : review
        ? 'FEED_MARKETS_REVIEW_LEASE_FILE'
        : npc
          ? 'FEED_NPC_TRADE_COUNT_LEASE_FILE'
          : fee
            ? 'FEED_PREDICTION_FEE_LEASE_FILE'
            : plugin
              ? 'FEED_PLUGIN_PERP_FEE_LEASE_FILE'
              : prediction
                ? 'FEED_PREDICTION_REMAINDER_LEASE_FILE'
                : mcpFee
                  ? 'FEED_MCP_PERP_FEE_LEASE_FILE'
                  : 'FEED_SUB_MARKET_LEASE_FILE';
  requireThat(
    !process.env.FEED_CLOSED_PREDICTION_POSITIONS_CHILD &&
      !process.env.FEED_CLOSED_PREDICTION_POSITIONS_LEASE_FILE &&
      !process.env.FEED_SUB_MARKET_CHILD &&
      !process.env.FEED_SUB_MARKET_LEASE_FILE &&
      !process.env.FEED_PREDICTION_REMAINDER_CHILD &&
      !process.env.FEED_PREDICTION_REMAINDER_LEASE_FILE &&
      !process.env.FEED_PLUGIN_PERP_FEE_CHILD &&
      !process.env.FEED_PLUGIN_PERP_FEE_LEASE_FILE &&
      !process.env.FEED_PREDICTION_FEE_CHILD &&
      !process.env.FEED_PREDICTION_FEE_LEASE_FILE &&
      !process.env.FEED_NPC_TRADE_COUNT_CHILD &&
      !process.env.FEED_NPC_TRADE_COUNT_LEASE_FILE &&
      !process.env.FEED_MARKETS_REVIEW_CHILD &&
      !process.env.FEED_MARKETS_REVIEW_LEASE_FILE &&
      !process.env.FEED_BALANCE_DISPLAY_CHILD &&
      !process.env.FEED_BALANCE_DISPLAY_LEASE_FILE &&
      !process.env.FEED_MCP_PERP_FEE_CHILD &&
      !process.env.FEED_MCP_PERP_FEE_LEASE_FILE,
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
      scenarioOrClosedPositions
        ? scenario
          ? 'feed-prediction-market-scenario-'
          : 'feed-closed-prediction-positions-'
        : balance
          ? 'feed-balance-display-'
          : review
            ? 'feed-markets-review-'
            : npc
              ? 'feed-npc-trade-count-'
              : fee
                ? 'feed-prediction-fee-'
                : plugin
                  ? 'feed-plugin-perp-fee-'
                  : prediction
                    ? 'feed-prediction-remainder-'
                    : mcpFee
                      ? 'feed-mcp-perp-fee-'
                      : tradeHistory
                        ? 'feed-trade-history-'
                        : stats
                          ? 'feed-stats-total-hoots-'
                          : activePlayers
                            ? 'feed-stats-active-players-'
                            : chatMentions
                              ? 'feed-chat-mentions-'
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
      ...(fixture ? { FEED_DISABLE_REDIS: '1', REDIS_URL: '' } : {}),
      // Fresh process memory only; never read or invalidate a shared cron cache.
      ...(scenario ? { FEED_DISABLE_REDIS: '1', REDIS_URL: '' } : {}),
      ...(review ? { FEED_DISABLE_REDIS: '1' } : {}),
      ...(balance ? { FEED_DISABLE_REDIS: '1', REDIS_URL: '' } : {}),
      ...(closedPositions ? { FEED_DISABLE_REDIS: '1', REDIS_URL: '' } : {}),
      ...(mcpFee || tradeHistory || stats || activePlayers || chatMentions
        ? { FEED_DISABLE_REDIS: '1', REDIS_URL: '' }
        : {}),
    };
    phase = 'migrate';
    await run(
      ['run', 'db:migrate'],
      env,
      join(directory, 'migrate.log'),
      60000
    );
    if (
      prediction ||
      plugin ||
      fee ||
      npc ||
      review ||
      balance ||
      closedPositions ||
      mcpFee ||
      tradeHistory ||
      fixture?.manualTradingFeeIndex
    ) {
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
    phase = scenarioOrClosedPositions
      ? scenario
        ? 'prediction-scenario-http-child-case'
        : 'eight-closed-prediction-position-child-cases'
      : balance
        ? 'five-balance-display-child-cases'
        : review
          ? 'two-markets-review-child-cases'
          : npc
            ? 'six-npc-trade-count-child-cases'
            : fee
              ? 'seven-prediction-fee-child-cases'
              : plugin
                ? 'six-child-cases'
                : prediction
                  ? 'ten-child-cases'
                  : mcpFee
                    ? 'three-mcp-perp-fee-child-cases'
                    : tradeHistory
                      ? 'trade-history-http-child-case'
                      : stats
                        ? 'three-stats-total-hoots-child-cases'
                        : activePlayers
                          ? 'three-stats-active-players-child-cases'
                          : chatMentions
                            ? 'three-chat-mention-child-cases'
                            : 'four-child-cases';
    if (fixture) phase = fixture.name + '-child-cases';
    const output = await run(
      [
        'test',
        fixture?.file ?? (scenario ? PREDICTION_SCENARIO_FILE : file),
        '--timeout',
        '30000',
      ],
      env,
      join(directory, 'child.log'),
      120000
    );
    const escape = (text: string) =>
      text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');
    const lines = output.split('\n');
    const expectedCases =
      fixture?.cases ?? (scenario ? PREDICTION_SCENARIO_CASES : cases);
    const passes = expectedCases.map((name) =>
      lines.find((line) =>
        new RegExp(
          '^\\(pass\\) ' +
            (fixture ||
            scenario ||
            prediction ||
            plugin ||
            fee ||
            npc ||
            review ||
            balance ||
            closedPositions ||
            mcpFee ||
            tradeHistory ||
            stats ||
            activePlayers ||
            chatMentions
              ? ''
              : 'sub-market transactional creation > ') +
            escape(name) +
            '(?: \\[|\\r?$)'
        ).test(line)
      )
    );
    requireThat(
      passes.every((line) => !!line) &&
        new RegExp('^\\s*' + expectedCases.length + ' pass\\r?$', 'm').test(
          output
        ) &&
        /^\s*0 fail\r?$/m.test(output) &&
        !/^\s*[1-9]\d* skip\r?$/m.test(output) &&
        output.includes(
          'Ran ' +
            expectedCases.length +
            (expectedCases.length === 1
              ? ' test across 1 file.'
              : ' tests across 1 file.')
        ),
      scenarioOrClosedPositions
        ? scenario
          ? 'Prediction scenario must pass over real HTTP without skips'
          : 'All eight closed prediction position cases must pass without skips'
        : balance
          ? 'All five balance display cases must pass without skips'
          : review
            ? 'Both manual-review and admin-resolution cases must pass without skips'
            : npc
              ? 'All six NPC history cases must pass without skips'
              : fee
                ? 'All seven real prediction fee cases must pass without skips'
                : plugin
                  ? 'All six real perp fee cases must pass without skips'
                  : prediction
                    ? 'All ten real HTTP cases must pass without skips'
                    : mcpFee
                      ? 'All three real MCP perp fee cases must pass without skips'
                      : tradeHistory
                        ? 'Trade history must pass over real HTTP without skips'
                        : stats
                          ? 'All three stats cases must pass over HTTP without skips'
                          : activePlayers
                            ? 'All three active players cases must pass over HTTP without skips'
                            : chatMentions
                              ? 'All three chat mention cases must pass over HTTP without skips'
                              : 'All four original cases must pass without skips'
    );
    childProof = {
      pass: expectedCases.length,
      skip: 0,
      fail: 0,
      cases: expectedCases,
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
      status: closedPositions
        ? 'PASS_ISOLATED_EIGHT_CLOSED_PREDICTION_POSITIONS_CASES'
        : balance
          ? 'PASS_ISOLATED_FIVE_BALANCE_DISPLAY_CASES'
          : review
            ? 'PASS_ISOLATED_MARKETS_REVIEW_CASE'
            : npc
              ? 'PASS_ISOLATED_SIX_NPC_TRADE_COUNT_CASES'
              : fee
                ? 'PASS_ISOLATED_SEVEN_PREDICTION_FEE_CASES'
                : plugin
                  ? 'PASS_ISOLATED_SIX_PLUGIN_PERP_FEE_CASES'
                  : prediction
                    ? 'PASS_ISOLATED_TEN_PREDICTION_REMAINDER_CASES'
                    : mcpFee
                      ? 'PASS_ISOLATED_THREE_MCP_PERP_FEE_CASES'
                      : tradeHistory
                        ? 'PASS_ISOLATED_TRADE_HISTORY_HTTP_CASE'
                        : 'PASS_ISOLATED_FOUR_SUB_MARKET_CASES',
      lease,
      childProof,
      databaseDropped: true,
      sourceDatabaseRowsNeverWritten: true,
      parentEnvironmentUnchanged: true,
    });
    console.info(
      (closedPositions
        ? 'ISOLATED_CLOSED_PREDICTION_POSITIONS_RESULT '
        : balance
          ? 'ISOLATED_BALANCE_DISPLAY_RESULT '
          : review
            ? 'ISOLATED_MARKETS_REVIEW_RESULT '
            : npc
              ? 'ISOLATED_NPC_TRADE_COUNT_RESULT '
              : fee
                ? 'ISOLATED_PREDICTION_FEE_RESULT '
                : plugin
                  ? 'ISOLATED_PLUGIN_PERP_FEE_RESULT '
                  : prediction
                    ? 'ISOLATED_PREDICTION_REMAINDER_RESULT '
                    : mcpFee
                      ? 'ISOLATED_MCP_PERP_FEE_RESULT '
                      : tradeHistory
                        ? 'ISOLATED_TRADE_HISTORY_RESULT '
                        : 'ISOLATED_SUB_MARKET_RESULT ') +
        JSON.stringify({
          pass: expectedCases.length,
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
        status: closedPositions
          ? 'HOLD_ISOLATED_CLOSED_PREDICTION_POSITIONS_CASES'
          : balance
            ? 'HOLD_ISOLATED_BALANCE_DISPLAY_CASES'
            : review
              ? 'HOLD_ISOLATED_MARKETS_REVIEW_CASE'
              : npc
                ? 'HOLD_ISOLATED_NPC_TRADE_COUNT_CASES'
                : fee
                  ? 'HOLD_ISOLATED_PREDICTION_FEE_CASES'
                  : plugin
                    ? 'HOLD_ISOLATED_PLUGIN_PERP_FEE_CASES'
                    : prediction
                      ? 'HOLD_ISOLATED_PREDICTION_REMAINDER_CASES'
                      : mcpFee
                        ? 'HOLD_ISOLATED_MCP_PERP_FEE_CASES'
                        : tradeHistory
                          ? 'HOLD_ISOLATED_TRADE_HISTORY_HTTP_CASE'
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
        (closedPositions
          ? 'ISOLATED_CLOSED_PREDICTION_POSITIONS_HOLD '
          : balance
            ? 'ISOLATED_BALANCE_DISPLAY_HOLD '
            : review
              ? 'ISOLATED_MARKETS_REVIEW_HOLD '
              : npc
                ? 'ISOLATED_NPC_TRADE_COUNT_HOLD '
                : fee
                  ? 'ISOLATED_PREDICTION_FEE_HOLD '
                  : plugin
                    ? 'ISOLATED_PLUGIN_PERP_FEE_HOLD '
                    : prediction
                      ? 'ISOLATED_PREDICTION_REMAINDER_HOLD '
                      : mcpFee
                        ? 'ISOLATED_MCP_PERP_FEE_HOLD '
                        : tradeHistory
                          ? 'ISOLATED_TRADE_HISTORY_HOLD '
                          : 'ISOLATED_SUB_MARKET_HOLD ') +
          JSON.stringify({ phase, result: resultPath })
      );
    }
    await admin.end({ timeout: 5 });
  }
}
