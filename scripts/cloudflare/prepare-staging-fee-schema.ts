#!/usr/bin/env bun
// PRD 9.1/9.3, MVP Phase 6: expand the protected staging database before upload.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FeeSchemaState,
  inspectOrPrepareFeeSchema,
  verifyChecks,
  verifyCommit,
} from './staging-fee-schema';
import {
  digest,
  endpoint,
  list,
  object,
  requireCondition,
  SchemaHold,
  text,
} from './staging-fee-schema-policy';

// Table grants alone do not establish access when RLS applies. This automatic
// rollout supports only catalog-proven bypass; it does not guess policy behavior.
export function verifyStagingAppRowAccess(state: FeeSchemaState): void {
  const flags = object(state.row.roleFlags);
  const rows = list(state.row.rowSecurity).map(object);
  requireCondition(
    typeof flags.superuser === 'boolean' &&
      typeof flags.bypassRls === 'boolean' &&
      rows.length === 2 &&
      JSON.stringify(rows.map((row) => row.table).sort()) ===
        '["TradingFee","TradingFeeOutbox"]' &&
      rows.every(
        (row) =>
          typeof row.enabled === 'boolean' &&
          typeof row.forced === 'boolean' &&
          typeof row.effectiveOwner === 'boolean'
      ),
    'unsupported_app_row_security'
  );
  requireCondition(
    rows.every(
      (row) =>
        row.enabled === false ||
        flags.superuser === true ||
        flags.bypassRls === true ||
        (row.effectiveOwner === true && row.forced === false)
    ),
    'unsupported_app_row_security'
  );
}

export function verifyStagingDeploymentContext(env: NodeJS.ProcessEnv): string {
  const sha = text(env.COMMIT_SHA);
  requireCondition(
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REPOSITORY === 'feedforagents/feed' &&
      env.GITHUB_REF === 'refs/heads/staging' &&
      env.TARGET === 'staging' &&
      /^[a-f0-9]{40}$/.test(sha) &&
      sha === env.GITHUB_SHA,
    'workflow_target_mismatch'
  );
  return sha;
}

let phase = 'workflow_guard';
export async function main() {
  const sha = verifyStagingDeploymentContext(process.env);
  const checkpoint = async () => {
    await verifyCommit(sha);
    await verifyChecks(sha);
  };
  await checkpoint();
  // These existing protected environment secrets are the target authority.
  // This path does not attest a live Hyperdrive or production binding.
  const app = endpoint(text(process.env.STAGING_DATABASE_URL));
  const direct = endpoint(text(process.env.STAGING_DIRECT_DATABASE_URL));
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'feed-staging-prepare-')
  );
  const ca = join(directory, 'database-ca.pem');
  try {
    writeFileSync(ca, text(process.env.DATABASE_CA_CERT), { mode: 0o600 });
    const state = await inspectOrPrepareFeeSchema({
      app,
      direct,
      ca,
      mode: 'prepare',
      beforeWrite: async (state) => {
        verifyStagingAppRowAccess(state);
        await checkpoint();
      },
      onPhase: (value) => {
        phase = value;
      },
    });
    phase = 'release_recheck';
    await checkpoint();
    verifyStagingAppRowAccess(state);
    console.info(
      JSON.stringify({
        status: 'PASS',
        mode: 'prepare',
        commit: sha,
        targetAuthority: 'protected-staging-database-config',
        readyForApplication: state.columnsReady && state.indexReady,
        tlsVerification: 'verify-ca',
        appRoleIdentityHash: digest(app.user),
        databaseIdentityHash: digest(
          JSON.stringify({
            host: app.host,
            port: app.port,
            database: app.database,
          })
        ),
        historyEntries: state.historyLength,
        columnsReady: state.columnsReady,
        indexReady: state.indexReady,
        feeTableOid: state.row.feeOid,
        outboxTableOid: state.row.outboxOid,
        indexOid: object(state.row.index).oid,
        appRoleGrants: state.row.grants,
        appRoleFlags: state.row.roleFlags,
        rowSecurity: state.row.rowSecurity,
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
