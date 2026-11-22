#!/usr/bin/env bun
// PRD D-25 and 9.2, MVP Phase 0: stage the spend ledger and market recovery storage.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStagingDeploymentContext } from './prepare-staging-fee-schema';
import {
  type FeeSchemaState,
  inspectOrPrepareFeeSchema,
  phase0Inspection,
  psql,
  verifyChecks,
  verifyCommit,
} from './staging-fee-schema';
import {
  digest,
  type Endpoint,
  endpoint,
  object,
  requireCondition,
  SchemaHold,
  text,
} from './staging-fee-schema-policy';

const migrations = {
  '0007': {
    filename: '0007_scheduled_inference_budget.sql',
    sha256: '67d04d140f3e49edf40acb749d0b408267289ae7938463146013e9760c39d8cf',
    table: 'ScheduledInferenceReservation',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  '0008': {
    filename: '0008_prediction_resolution_work.sql',
    sha256: '9eb07e4a49783bdcb83c8fb308bc04cb11b9a19fc7ac9653049e54acf1a4351b',
    table: 'PredictionResolutionWork',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
} as const;
type MigrationId = keyof typeof migrations;

const questionTable = 'public."Question"';

function sqlLiteral(value: string) {
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function migrationTransaction(
  id: MigrationId,
  state: FeeSchemaState,
  app: Endpoint,
  direct: Endpoint,
  migration: string
) {
  const appUser = sqlLiteral(app.user);
  const appRole = `"${app.user.replaceAll('"', '""')}"`;
  const { table, privileges } = migrations[id];
  const workTable = `public."${table}"`;
  const appHasAccess = privileges
    .map(
      (privilege) =>
        `pg_catalog.has_table_privilege(${appUser}, '${workTable}', '${privilege}')`
    )
    .join(' AND ');
  const relatedTableGuard =
    id === '0007'
      ? `OR pg_catalog.to_regclass('public."PredictionResolutionWork"')::pg_catalog.oid::pg_catalog.text IS DISTINCT FROM ${sqlLiteral(text(object(object(state.row.phase0Tables).PredictionResolutionWork).oid))}`
      : `OR pg_catalog.to_regclass('"Question"') IS DISTINCT FROM pg_catalog.to_regclass('${questionTable}')
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
      WHERE c.oid = pg_catalog.to_regclass('${questionTable}') AND c.relkind = 'r'
        AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
        AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        AND k.contype = 'p' AND k.convalidated AND k.conkey = ARRAY[a.attnum]
    )`;
  const pinQuestion =
    id === '0008'
      ? `PERFORM pg_catalog.set_config('feed.staging_0008_question_oid',
    pg_catalog.to_regclass('${questionTable}')::pg_catalog.oid::pg_catalog.text, true);`
      : '';
  const questionForeignKey =
    id === '0008'
      ? `AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid
      AND k.contype = 'f' AND k.convalidated AND k.confdeltype = 'c'
      AND k.confrelid = pg_catalog.to_regclass('${questionTable}')
      AND k.confrelid = pg_catalog.current_setting('feed.staging_0008_question_oid')::pg_catalog.oid)`
      : '';
  return `BEGIN READ WRITE;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = public, pg_temp;
DO ${sqlLiteral(`BEGIN
  IF NOT COALESCE(
    pg_catalog.current_database() = ${sqlLiteral(direct.database)}
    AND current_user = ${sqlLiteral(direct.user)}
    AND session_user = ${sqlLiteral(direct.user)}
    AND NOT pg_catalog.pg_is_in_recovery()
    AND pg_catalog.host(pg_catalog.inet_server_addr()) = ${sqlLiteral(text(state.row.address))}
    AND pg_catalog.inet_server_port() = ${Number(state.row.port)}
    AND (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid())
    AND pg_catalog.to_regclass('public."TradingFee"')::pg_catalog.oid::pg_catalog.text = ${sqlLiteral(text(state.row.feeOid))}
    AND pg_catalog.to_regclass('public."TradingFeeOutbox"')::pg_catalog.oid::pg_catalog.text = ${sqlLiteral(text(state.row.outboxOid))}, false
  ) THEN
    RAISE EXCEPTION 'staging database identity mismatch';
  END IF;

  IF pg_catalog.to_regclass('${workTable}') IS NOT NULL
    ${relatedTableGuard} THEN
    RAISE EXCEPTION 'manual migration target mismatch';
  END IF;
  ${pinQuestion}
END`)} LANGUAGE plpgsql;
${migration}
DO ${sqlLiteral(`BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = pg_catalog.to_regclass('${workTable}') AND c.relkind = 'r'
      AND NOT c.relrowsecurity AND c.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid
      ${questionForeignKey}
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.attacl) a
        WHERE p.attrelid = c.oid AND p.attnum > 0 AND NOT p.attisdropped AND a.grantee = 0
      )
  ) THEN
    RAISE EXCEPTION 'created manual migration table mismatch';
  END IF;
  IF NOT (${appHasAccess}) THEN
    EXECUTE ${sqlLiteral(`GRANT ${privileges.join(', ')} ON TABLE ${workTable} TO ${appRole}`)};
  END IF;
  IF NOT (${appHasAccess}) THEN
    RAISE EXCEPTION 'manual migration table grants missing';
  END IF;
END`)} LANGUAGE plpgsql;
COMMIT;`;
}

function existingCheckpoint(state: FeeSchemaState, id: MigrationId) {
  const other = migrations[id === '0007' ? '0008' : '0007'].table;
  return {
    database: state.row.database,
    address: state.row.address,
    port: state.row.port,
    history: state.row.history,
    fundingReady: state.fundingReady,
    fundingLedger: state.row.fundingLedger,
    columns: state.row.columns,
    feeOid: state.row.feeOid,
    outboxOid: state.row.outboxOid,
    index: state.row.index,
    otherMigration: object(state.row.phase0Tables)[other],
  };
}

interface ApplyOptions {
  app: Endpoint;
  direct: Endpoint;
  ca: string;
  beforeWrite: () => Promise<void>;
  onPhase?: (phase: string) => void;
}

export async function applyStagingPhase0(
  id: MigrationId,
  { app, direct, ca, beforeWrite, onPhase }: ApplyOptions
) {
  const { filename, sha256, table } = migrations[id];
  const migration = readFileSync(
    new URL(
      `../../packages/db/drizzle/migrations/manual/${filename}`,
      import.meta.url
    ),
    'utf8'
  );
  requireCondition(digest(migration) === sha256, 'migration_source_mismatch');
  const inspect = () =>
    inspectOrPrepareFeeSchema({
      app,
      direct,
      ca,
      mode: 'inspect',
      allowStagingBaselineAdditive: true,
      includePhase0: true,
      beforeWrite,
    });
  onPhase?.('readonly_catalog');
  const before = await inspect();
  requireCondition(
    before.columnsReady && before.indexReady && before.fundingReady,
    'staging_checkpoint_incomplete'
  );
  const tables = object(before.row.phase0Tables);
  if (id === '0007') {
    const recovery = phase0Inspection(tables).migration0008;
    const recoveryTable = object(tables.PredictionResolutionWork);
    requireCondition(
      recovery.catalogMatches &&
        recovery.appRoleAccess &&
        recoveryTable.indexes === null &&
        recoveryTable.publicAccess === false,
      'staging_recovery_checkpoint_incomplete'
    );
  }
  const existing = object(tables[table]);
  const action = existing.kind === null ? 'applied' : 'already_applied';
  let after = before;
  if (action === 'applied') {
    onPhase?.('prewrite_checkpoint');
    await beforeWrite();
    onPhase?.(`apply_${id}`);
    psql(
      direct,
      ca,
      migrationTransaction(id, before, app, direct, migration),
      true
    );
    onPhase?.(`verify_${id}`);
    after = await inspect();
    requireCondition(
      JSON.stringify(existingCheckpoint(before, id)) ===
        JSON.stringify(existingCheckpoint(after, id)),
      'staging_checkpoint_changed'
    );
  }
  const afterTables = object(after.row.phase0Tables);
  const phase0Schema = phase0Inspection(afterTables);
  const expected =
    id === '0007' ? phase0Schema.migration0007 : phase0Schema.migration0008;
  const target = object(afterTables[table]);
  requireCondition(
    expected.catalogMatches &&
      expected.appRoleAccess &&
      target.publicAccess === false &&
      (id === '0007'
        ? Object.keys(object(target.indexes ?? {})).length === 2
        : target.indexes === null),
    'manual_schema_drift'
  );
  return {
    action,
    phase0Schema,
    checkpoint: {
      historyEntries: after.historyLength + Number(after.fundingReady),
      columnsReady: after.columnsReady,
      indexReady: after.indexReady,
      fundingLedgerReady: after.fundingReady,
    },
  };
}

let phase = 'workflow_guard';

async function main() {
  const id = process.argv[2];
  requireCondition(
    process.argv.length === 3 && (id === '0007' || id === '0008'),
    'invalid_manual_migration'
  );
  const sha = verifyStagingDeploymentContext(process.env);
  requireCondition(
    process.env.STAGING_GAME_PAUSED === 'true',
    'staging_game_not_paused'
  );
  const app = endpoint(text(process.env.STAGING_DATABASE_URL));
  const direct = endpoint(text(process.env.STAGING_DIRECT_DATABASE_URL));
  const databaseIdentityHash = digest(
    JSON.stringify({ host: app.host, port: app.port, database: app.database })
  );
  const appRoleIdentityHash = digest(app.user);
  requireCondition(
    databaseIdentityHash === process.env.EXPECTED_DATABASE_IDENTITY &&
      appRoleIdentityHash === process.env.EXPECTED_APP_ROLE_IDENTITY,
    'staging_target_identity_mismatch'
  );
  const verifyRevision = async () => {
    await verifyCommit(sha);
    await verifyChecks(sha);
  };
  await verifyRevision();
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), `feed-staging-${id}-`)
  );
  const ca = join(directory, 'database-ca.pem');
  try {
    writeFileSync(ca, text(process.env.DATABASE_CA_CERT), { mode: 0o600 });
    const result = await applyStagingPhase0(id, {
      app,
      direct,
      ca,
      beforeWrite: verifyRevision,
      onPhase: (value) => {
        phase = value;
      },
    });
    phase = 'release_recheck';
    await verifyRevision();
    console.info(
      JSON.stringify({
        status: 'PASS',
        commit: sha,
        migration: id,
        migrationSha256: migrations[id].sha256,
        targetAuthority: 'protected-staging-database-config',
        tlsVerification: 'verify-ca',
        databaseIdentityHash,
        appRoleIdentityHash,
        ...result,
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
            : 'unexpected_schema_failure',
      })
    );
    process.exitCode = 1;
  }
}
