#!/usr/bin/env bun
// PRD 9.1/9.3, MVP Phase 6: schema-before-application fee accounting rollout.
// Never import application ORM metadata or print raw provider/driver failures.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  digest,
  type Endpoint,
  endpoint,
  list,
  MIGRATION_HISTORY_SAMPLE_LIMIT,
  type Migration,
  object,
  origin,
  physicalFeeSchemaDiagnostics,
  requireCondition,
  SchemaHold,
  sameDatabase,
  text,
  verifyColumns,
  verifyEndpoints,
  verifyHistory,
  verifyIndex,
} from './staging-fee-schema-policy';

const ROOT = resolve(import.meta.dir, '../..');
const MIGRATIONS = join(ROOT, 'packages/db/drizzle/migrations');
const STAGING_BINDING = 'e379cb0027b449588ee8eee7250ceffa';
const PRODUCTION_BINDING = '5d4f76cda3ea4a12990460442c657442';
const requiredChecks = [
  'Quality Gate',
  'Run All Tests',
  'Cloudflare build',
  'env:audit:check',
  'CI - Tests',
];
let phase = 'workflow_guard';
const secret = (value: string | undefined) => text(value);

async function jsonGet(url: string, token: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SchemaHold('metadata_request_failed');
  }
  requireCondition(response.ok, `metadata_http_${response.status}`);
  const raw = await response.text();
  requireCondition(raw.length < 2_000_000, 'metadata_too_large');
  try {
    return object(JSON.parse(raw));
  } catch {
    throw new SchemaHold('invalid_metadata');
  }
}
export async function verifyCommit(expected: string) {
  const token = secret(process.env.GH_TOKEN);
  const current = await jsonGet(
    'https://api.github.com/repos/feedforagents/feed/git/ref/heads/staging',
    token
  );
  requireCondition(object(current.object).sha === expected, 'staging_advanced');
}
export async function verifyChecks(expected: string) {
  const result = await jsonGet(
    `https://api.github.com/repos/feedforagents/feed/commits/${expected}/check-runs?per_page=100`,
    secret(process.env.GH_TOKEN)
  );
  const runs = list(result.check_runs).map(object);
  for (const name of requiredChecks) {
    const matching = runs.filter(
      (run) => run.name === name && object(run.app).slug === 'github-actions'
    );
    matching.sort((a, b) => Number(b.id) - Number(a.id));
    requireCondition(
      matching[0]?.conclusion === 'success' &&
        matching[0]?.status === 'completed',
      'required_check_not_successful'
    );
  }
}
async function cloudflare(path: string) {
  const account = secret(process.env.CLOUDFLARE_ACCOUNT_ID);
  requireCondition(/^[a-f0-9]{32}$/.test(account), 'invalid_account_id');
  const result = await jsonGet(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    secret(process.env.CLOUDFLARE_API_TOKEN)
  );
  requireCondition(result.success === true, 'cloudflare_request_failed');
  return object(result.result);
}
async function liveOrigin(
  environment: 'staging' | 'production',
  expectedBinding: string,
  expectedCommit?: string
) {
  const script = `workers/scripts/feed-web-${environment}`;
  const deployments = await cloudflare(`${script}/deployments`);
  const active = object(list(deployments.deployments)[0]);
  const versions = list(active.versions).map(object);
  requireCondition(
    versions.length === 1 && versions[0]?.percentage === 100,
    'worker_traffic_split'
  );
  const version = text(versions[0]?.version_id);
  requireCondition(/^[a-f0-9-]{36}$/.test(version), 'invalid_worker_version');
  const details = await cloudflare(`${script}/versions/${version}`);
  requireCondition(details.id === version, 'worker_version_mismatch');
  const allBindings = list(object(details.resources).bindings).map(object);
  const bindings = allBindings.filter(
    (binding) => binding.name === 'HYPERDRIVE'
  );
  requireCondition(
    bindings.length === 1 &&
      bindings[0]?.type === 'hyperdrive' &&
      bindings[0]?.id === expectedBinding,
    'live_binding_mismatch'
  );
  if (expectedCommit) {
    const commits = allBindings.filter(
      (binding) => binding.name === 'COMMIT_SHA'
    );
    requireCondition(
      commits.length === 1 &&
        commits[0]?.type === 'plain_text' &&
        commits[0]?.text === expectedCommit,
      'live_worker_commit_mismatch'
    );
  }
  const configuration = await cloudflare(
    `hyperdrive/configs/${expectedBinding}`
  );
  requireCondition(
    configuration.id === expectedBinding,
    'hyperdrive_identity_mismatch'
  );
  return {
    origin: origin(configuration.origin),
    version,
    deployment: text(active.id),
  };
}
function expectedMigrations(): Migration[] {
  const journal = object(
    JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'))
  );
  const entries = list(journal.entries).map(object);
  const tags = [
    '0000_fresh_baseline',
    '0001_remove_farcaster',
    '0002_remove_collectible_nfts',
    '0003_prediction_cash_cost_basis',
    '0004_leverage_cap_20',
    '0005_trading_fee_idempotency_key',
  ];
  requireCondition(entries.length === tags.length, 'unexpected_journal');
  return entries.map((entry, index) => {
    requireCondition(
      entry.idx === index &&
        entry.tag === tags[index] &&
        typeof entry.when === 'number' &&
        Number.isSafeInteger(entry.when),
      'unexpected_journal'
    );
    return {
      hash: digest(
        readFileSync(join(MIGRATIONS, `${tags[index]}.sql`), 'utf8')
      ),
      when: String(entry.when),
    };
  });
}
function pgEnvironment(
  target: Endpoint,
  ca: string,
  writable = false
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.RUNNER_TEMP || tmpdir(),
    LANG: 'C.UTF-8',
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGDATABASE: target.database,
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGSSLMODE: 'verify-ca',
    PGSSLROOTCERT: ca,
    PGPASSFILE: '/dev/null',
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'feed-staging-fee-schema',
    PGOPTIONS: writable
      ? '-c statement_timeout=900000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c search_path=pg_catalog,public'
      : '-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c default_transaction_read_only=on -c search_path=pg_catalog,public',
  };
}
function psql(
  target: Endpoint,
  ca: string,
  input: string,
  writable = false
): string {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '--no-password',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
    ],
    {
      cwd: ROOT,
      env: pgEnvironment(target, ca, writable),
      input,
      encoding: 'utf8',
      timeout: writable ? 930_000 : 30_000,
      maxBuffer: 1_000_000,
    }
  );
  requireCondition(
    !result.error && result.status === 0 && !result.signal,
    writable ? 'manual_schema_step_failed' : 'catalog_inspection_failed'
  );
  return result.stdout.trim();
}
const catalogSql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
  'database',current_database(),'role',current_user,'sessionRole',session_user,
  'address',pg_catalog.host(inet_server_addr()),'port',inet_server_port(),
  'replica',pg_is_in_recovery(),'readOnly',current_setting('transaction_read_only'),
  'tls',(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),
  'feeOid',pg_catalog.to_regclass('public."TradingFee"')::oid::text,
  'outboxOid',pg_catalog.to_regclass('public."TradingFeeOutbox"')::oid::text,
  'columns',COALESCE((SELECT json_agg(json_build_object('table',c.relname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'hasDefault',a.atthasdef,'dropped',a.attisdropped))
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    WHERE c.oid IN (pg_catalog.to_regclass('public."TradingFee"'),pg_catalog.to_regclass('public."TradingFeeOutbox"')) AND a.attname='idempotencyKey' AND a.attnum>0),'[]'::json),
  'index',(SELECT json_build_object('targetMatches',ix.indrelid=pg_catalog.to_regclass('public."TradingFee"'),'oid',i.oid::text,'kind',i.relkind,'method',am.amname,'unique',ix.indisunique,'valid',ix.indisvalid,'ready',ix.indisready,'live',ix.indislive,'keys',ix.indnkeyatts,'attributes',ix.indnatts,'noExpressions',ix.indexprs IS NULL,'predicate',pg_catalog.pg_get_expr(ix.indpred,ix.indrelid),'columns',ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum,ord) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum ORDER BY k.ord)) FROM pg_catalog.pg_class i JOIN pg_catalog.pg_index ix ON ix.indexrelid=i.oid JOIN pg_catalog.pg_am am ON am.oid=i.relam WHERE i.oid=pg_catalog.to_regclass('public."TradingFee_idempotencyKey_idx"')),
  'history',(SELECT json_agg(json_build_object('hash',h.hash,'when',h.created_at::text) ORDER BY h.id) FROM (SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${MIGRATION_HISTORY_SAMPLE_LIMIT}) h),
  'grants',json_build_object('schema',has_schema_privilege(current_user,'public','USAGE'),'feeSelect',has_table_privilege(current_user,'public."TradingFee"','SELECT'),'feeInsert',has_table_privilege(current_user,'public."TradingFee"','INSERT'),'outboxSelect',has_table_privilege(current_user,'public."TradingFeeOutbox"','SELECT'),'outboxInsert',has_table_privilege(current_user,'public."TradingFeeOutbox"','INSERT'),'outboxUpdate',has_table_privilege(current_user,'public."TradingFeeOutbox"','UPDATE'),'outboxDelete',has_table_privilege(current_user,'public."TradingFeeOutbox"','DELETE')),
  'roleFlags',(SELECT json_build_object('superuser',rolsuper,'bypassRls',rolbypassrls) FROM pg_catalog.pg_roles WHERE rolname=current_user),
  'rowSecurity',(SELECT json_agg(json_build_object('table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity,'effectiveOwner',pg_has_role(current_user,c.relowner,'USAGE'))) FROM pg_catalog.pg_class c WHERE c.oid IN (pg_catalog.to_regclass('public."TradingFee"'),pg_catalog.to_regclass('public."TradingFeeOutbox"'))),
  'canMigrate',(SELECT bool_and(pg_has_role(current_user,c.relowner,'USAGE')) FROM pg_catalog.pg_class c WHERE c.oid IN (pg_catalog.to_regclass('public."TradingFee"'),pg_catalog.to_regclass('public."TradingFeeOutbox"')))
);
ROLLBACK;`;
function inspect(target: Endpoint, ca: string, migrations: Migration[]) {
  const row = object(JSON.parse(psql(target, ca, catalogSql)));
  requireCondition(
    row.database === target.database &&
      row.role === target.user &&
      row.sessionRole === target.user &&
      row.replica === false &&
      row.tls === true &&
      row.readOnly === 'on',
    'database_identity_or_tls_mismatch'
  );
  text(row.feeOid);
  text(row.outboxOid);
  text(row.address);
  let historyLength: number;
  try {
    historyLength = verifyHistory(row.history, migrations);
  } catch (error) {
    if (error instanceof SchemaHold && error.migrationHistory) {
      error.migrationHistory.physicalFeature = physicalFeeSchemaDiagnostics(
        row.columns,
        row.index
      );
    }
    throw error;
  }
  const columnsReady = verifyColumns(row.columns, historyLength);
  const indexReady = verifyIndex(row.index);
  requireCondition(
    columnsReady || !indexReady,
    'index_without_receipted_columns'
  );
  return { row, historyLength, columnsReady, indexReady };
}
export function migrationUrl(target: Endpoint, ca: string) {
  const url = new URL('postgresql://invalid');
  url.hostname = target.host;
  url.port = String(target.port);
  url.pathname = '/' + target.database;
  url.username = target.user;
  url.password = target.password;
  url.searchParams.set('uselibpqcompat', 'true');
  url.searchParams.set('sslmode', 'verify-ca');
  url.searchParams.set('sslrootcert', ca);
  url.searchParams.set(
    'options',
    '-c statement_timeout=900000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c search_path=pg_catalog,public'
  );
  return url.href;
}
export function verifyMigrationDriver(connectionString: string, ca: string) {
  // Resolve pg exactly where the actual CLI module resolves it, including
  // package-store symlinks; lexical workspace paths can select another pg.
  const bin = realpathSync(
    join(ROOT, 'packages/db/node_modules/drizzle-kit/bin.cjs')
  );
  const require = createRequire(bin);
  const kit = object(
    JSON.parse(readFileSync(join(dirname(bin), 'package.json'), 'utf8'))
  );
  const version = object(
    JSON.parse(readFileSync(require.resolve('pg/package.json'), 'utf8'))
  );
  requireCondition(
    kit.version === '0.31.10' && version.version === '8.20.0',
    'unreviewed_migration_driver'
  );
  const driver = object(require('pg'));
  const Client = driver.Client;
  requireCondition(typeof Client === 'function', 'pg_driver_unavailable');
  const client = new (
    Client as new (config: {
      connectionString: string;
    }) => { connectionParameters: { ssl: unknown; options?: string } }
  )({ connectionString });
  const ssl = object(client.connectionParameters.ssl);
  requireCondition(
    ssl.ca === readFileSync(ca, 'utf8') &&
      ssl.rejectUnauthorized !== false &&
      typeof ssl.checkServerIdentity === 'function' &&
      client.connectionParameters.options?.includes('lock_timeout=1000') ===
        true &&
      client.connectionParameters.options?.includes(
        'statement_timeout=900000'
      ) === true,
    'migration_tls_or_timeout_mismatch'
  );
}

export type FeeSchemaState = ReturnType<typeof inspect>;
export interface FeeSchemaDatabaseOptions {
  app: Endpoint;
  direct: Endpoint;
  ca: string;
  mode: 'inspect' | 'prepare';
  beforeWrite: (state: FeeSchemaState) => Promise<void>;
  onPhase?: (phase: string) => void;
}
function verifyDatabaseIdentity(app: FeeSchemaState, direct: FeeSchemaState) {
  requireCondition(
    app.row.database === direct.row.database &&
      app.row.address === direct.row.address &&
      app.row.port === direct.row.port &&
      app.row.feeOid === direct.row.feeOid &&
      app.row.outboxOid === direct.row.outboxOid,
    'app_direct_server_mismatch'
  );
}
function verifyDatabasePair(app: FeeSchemaState, direct: FeeSchemaState) {
  verifyDatabaseIdentity(app, direct);
  requireCondition(
    app.historyLength === direct.historyLength,
    'app_direct_server_mismatch'
  );
}

// PRD 9.1/9.3, MVP Phase 6: database expansion must precede new fee writers.
// Callers supply target authority: the metadata inspector verifies live bindings;
// the deploy prerequisite trusts the existing protected staging database config.
// This core has no Cloudflare or GitHub calls; owned local TLS tests use it too.
export async function inspectOrPrepareFeeSchema({
  app,
  direct,
  ca,
  mode,
  beforeWrite,
  onPhase,
}: FeeSchemaDatabaseOptions): Promise<FeeSchemaState> {
  requireCondition(
    ['inspect', 'prepare'].includes(mode),
    'invalid_schema_mode'
  );
  requireCondition(
    sameDatabase(app, direct),
    'direct_origin_identity_mismatch'
  );
  const migrations = expectedMigrations();
  onPhase?.('readonly_catalog');
  let appState = inspect(app, ca, migrations);
  const directState = inspect(direct, ca, migrations);
  verifyDatabasePair(appState, directState);
  requireCondition(
    Object.values(object(appState.row.grants)).every((value) => value === true),
    'app_role_grants_missing'
  );
  if (mode === 'prepare') {
    requireCondition(
      directState.row.canMigrate === true,
      'migration_role_not_owner'
    );
    await beforeWrite(appState);
    if (appState.historyLength === 5) {
      onPhase?.('normal_column_migration');
      const url = migrationUrl(direct, ca);
      verifyMigrationDriver(url, ca);
      const result = spawnSync('bun', ['run', 'db:migrate'], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.RUNNER_TEMP || tmpdir(),
          NODE_ENV: 'production',
          DIRECT_DATABASE_URL: url,
          DATABASE_URL: url,
          DATABASE_CA_CERT: readFileSync(ca, 'utf8'),
          PGOPTIONS: pgEnvironment(direct, ca, true).PGOPTIONS,
        },
        encoding: 'utf8',
        timeout: 930_000,
        maxBuffer: 2_000_000,
      });
      requireCondition(
        !result.error &&
          result.status === 0 &&
          !result.signal &&
          result.stdout.includes("Using 'pg' driver"),
        'normal_migration_failed'
      );
    }
    const columns = inspect(app, ca, migrations);
    verifyDatabaseIdentity(columns, directState);
    requireCondition(
      columns.columnsReady && columns.historyLength === 6,
      'column_migration_not_verified'
    );
    await beforeWrite(columns);
    onPhase?.('concurrent_index');
    psql(
      direct,
      ca,
      readFileSync(
        join(
          MIGRATIONS,
          'manual/0005b_trading_fee_idempotency_key_idx_concurrently.sql'
        ),
        'utf8'
      ),
      true
    );
    appState = inspect(app, ca, migrations);
    verifyDatabaseIdentity(appState, directState);
    requireCondition(
      appState.columnsReady &&
        appState.indexReady &&
        appState.historyLength === 6,
      'prepared_schema_not_verified'
    );
  }
  if (mode === 'prepare') {
    verifyDatabasePair(appState, inspect(direct, ca, migrations));
  }
  requireCondition(
    Object.values(object(appState.row.grants)).every((value) => value === true),
    'app_role_grants_missing'
  );
  return appState;
}

export async function main() {
  const sha = secret(process.env.EXPECTED_SHA);
  const mode = process.env.SCHEMA_MODE || 'inspect';
  requireCondition(
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.GITHUB_REPOSITORY === 'feedforagents/feed' &&
      process.env.GITHUB_REF === 'refs/heads/staging' &&
      /^[a-f0-9]{40}$/.test(sha) &&
      sha === process.env.GITHUB_SHA &&
      ['inspect', 'prepare'].includes(mode),
    'workflow_target_mismatch'
  );
  await verifyCommit(sha);
  await verifyChecks(sha);
  phase = 'live_binding_identity';
  const staging = await liveOrigin('staging', STAGING_BINDING, sha);
  const production = await liveOrigin('production', PRODUCTION_BINDING);
  const app = endpoint(secret(process.env.STAGING_DATABASE_URL));
  const direct = endpoint(secret(process.env.STAGING_DIRECT_DATABASE_URL));
  verifyEndpoints(app, direct, staging.origin, production.origin);
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'feed-staging-schema-')
  );
  const ca = join(directory, 'database-ca.pem');
  try {
    writeFileSync(ca, secret(process.env.DATABASE_CA_CERT), { mode: 0o600 });
    const appState = await inspectOrPrepareFeeSchema({
      app,
      direct,
      ca,
      mode: mode as 'inspect' | 'prepare',
      beforeWrite: () => verifyCommit(sha),
      onPhase: (value) => {
        phase = value;
      },
    });
    await verifyCommit(sha);
    phase = 'postverification';
    const finalLive = await liveOrigin('staging', STAGING_BINDING, sha);
    requireCondition(
      finalLive.version === staging.version &&
        JSON.stringify(finalLive.origin) === JSON.stringify(staging.origin),
      'live_binding_changed'
    );
    requireCondition(
      Object.values(object(appState.row.grants)).every(
        (value) => value === true
      ),
      'app_role_grants_missing'
    );
    console.info(
      JSON.stringify({
        status: 'PASS',
        mode,
        commit: sha,
        stagingBinding: STAGING_BINDING,
        workerVersion: staging.version,
        workerDeployment: staging.deployment,
        readyForApplication: appState.columnsReady && appState.indexReady,
        productionBindingDistinct: true,
        appOriginRoleMatches: true,
        directServerMatches: true,
        tlsVerified: true,
        appRoleIdentityHash: digest(app.user),
        databaseIdentityHash: digest(JSON.stringify(staging)),
        historyEntries: appState.historyLength,
        columnsReady: appState.columnsReady,
        indexReady: appState.indexReady,
        feeTableOid: appState.row.feeOid,
        outboxTableOid: appState.row.outboxOid,
        indexOid:
          appState.row.index === null ? null : object(appState.row.index).oid,
        appRoleGrants: appState.row.grants,
        appRoleFlags: appState.row.roleFlags,
        rowSecurity: appState.row.rowSecurity,
      })
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'HOLD',
        phase,
        reason:
          error instanceof SchemaHold
            ? error.reason
            : 'unexpected_inspection_failure',
      })
    );
    process.exitCode = 1;
  }
}
