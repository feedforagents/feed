import { describe, expect, it } from 'bun:test';
import {
  verifyStagingAppRowAccess,
  verifyStagingDeploymentContext,
} from './prepare-staging-fee-schema';
import {
  endpoint,
  MIGRATION_HISTORY_SAMPLE_LIMIT,
  physicalFeeSchemaDiagnostics,
  SchemaHold,
  verifyColumns,
  verifyEndpoints,
  verifyHistory,
  verifyIndex,
} from './staging-fee-schema-policy';

const app = endpoint('postgresql://app:private@staging.invalid:5432/game');
const direct = { ...app, user: 'migration' };
const production = { ...app, database: 'production' };
const history = Array.from({ length: 6 }, (_, i) => ({
  hash: `hash${i}`,
  when: String(i + 1),
}));
function captureSchemaHold(run: () => void): SchemaHold {
  try {
    run();
  } catch (error) {
    if (error instanceof SchemaHold) return error;
    throw error;
  }
  throw new Error('Expected a schema HOLD');
}
const columns = ['TradingFee', 'TradingFeeOutbox'].map((table) => ({
  table,
  type: 'text',
  notNull: false,
  hasDefault: false,
  dropped: false,
}));
const index = {
  targetMatches: true,
  method: 'btree',
  kind: 'i',
  unique: true,
  valid: true,
  ready: true,
  live: true,
  keys: 1,
  attributes: 1,
  noExpressions: true,
  columns: ['idempotencyKey'],
  predicate: '("idempotencyKey" IS NOT NULL)',
};
const accessState = {
  row: {
    roleFlags: { superuser: false, bypassRls: false },
    rowSecurity: ['TradingFee', 'TradingFeeOutbox'].map((table) => ({
      table,
      enabled: true,
      forced: false,
      effectiveOwner: true,
    })),
  },
  historyLength: 6,
  columnsReady: true,
  indexReady: true,
};

describe('staging fee schema release boundaries', () => {
  it('allows only catalog-proven app access without guessing RLS policies', () => {
    expect(() => verifyStagingAppRowAccess(accessState)).not.toThrow();
    expect(() =>
      verifyStagingAppRowAccess({
        ...accessState,
        row: {
          ...accessState.row,
          rowSecurity: accessState.row.rowSecurity.map((row) => ({
            ...row,
            enabled: false,
            forced: true,
            effectiveOwner: false,
          })),
        },
      })
    ).not.toThrow();
    for (const roleFlags of [
      { superuser: true, bypassRls: false },
      { superuser: false, bypassRls: true },
    ]) {
      expect(() =>
        verifyStagingAppRowAccess({
          ...accessState,
          row: {
            roleFlags,
            rowSecurity: accessState.row.rowSecurity.map((row) => ({
              ...row,
              forced: true,
              effectiveOwner: false,
            })),
          },
        })
      ).not.toThrow();
    }
  });
  it('holds forced owners, non-owners and malformed app RLS metadata', () => {
    const rows = accessState.row.rowSecurity;
    for (const rowSecurity of [
      rows.map((row) => ({ ...row, forced: true })),
      rows.map((row) => ({ ...row, effectiveOwner: false })),
      [],
      rows.slice(0, 1),
      [rows[0], rows[0]],
      [rows[0], { ...rows[1], table: 'User' }],
      rows.map((row) => ({ ...row, enabled: 'true' })),
      rows.map((row) => ({ ...row, forced: undefined })),
      rows.map((row) => ({ ...row, effectiveOwner: 'true' })),
    ]) {
      expect(() =>
        verifyStagingAppRowAccess({
          ...accessState,
          row: { ...accessState.row, rowSecurity },
        })
      ).toThrow('unsupported_app_row_security');
    }
    for (const roleFlags of [
      { superuser: 'true', bypassRls: false },
      { superuser: false },
    ]) {
      expect(() =>
        verifyStagingAppRowAccess({
          ...accessState,
          row: { ...accessState.row, roleFlags },
        })
      ).toThrow('unsupported_app_row_security');
    }
  });
  it('permits only the selected exact staging deployment before database work', () => {
    const sha = 'a'.repeat(40);
    const env = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: 'feedforagents/feed',
      GITHUB_REF: 'refs/heads/staging',
      GITHUB_SHA: sha,
      TARGET: 'staging',
      COMMIT_SHA: sha,
    };
    expect(verifyStagingDeploymentContext(env)).toBe(sha);
    for (const changed of [
      { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_REPOSITORY: 'contributor/feed' },
      { GITHUB_REF: 'refs/heads/production' },
      { TARGET: 'production' },
      { GITHUB_SHA: 'b'.repeat(40) },
      { COMMIT_SHA: 'short' },
    ]) {
      expect(() =>
        verifyStagingDeploymentContext({ ...env, ...changed })
      ).toThrow('workflow_target_mismatch');
    }
    expect(() =>
      verifyStagingDeploymentContext({ ...env, COMMIT_SHA: '' })
    ).toThrow('invalid_string');
  });
  it('requires the actual app origin role and a distinct production database', () => {
    expect(() => verifyEndpoints(app, direct, app, production)).not.toThrow();
    expect(() =>
      verifyEndpoints(app, direct, { ...app, user: 'another' }, production)
    ).toThrow('app_origin_identity_mismatch');
    expect(() =>
      verifyEndpoints(
        app,
        { ...direct, host: 'other.invalid' },
        app,
        production
      )
    ).toThrow('direct_origin_identity_mismatch');
    expect(() =>
      verifyEndpoints(app, direct, app, { ...app, user: 'production' })
    ).toThrow('staging_equals_production');
  });
  it('accepts only the exact five-entry prefix or all six real migration receipts', () => {
    expect(verifyHistory(history.slice(0, 5), history)).toBe(5);
    expect(verifyHistory(history, history)).toBe(6);
    expect(() => verifyHistory(history.slice(1), history)).toThrow(
      'migration_history_mismatch'
    );
    expect(() => verifyHistory([...history, history[0]], history)).toThrow(
      'unexpected_migration_count'
    );
    expect(() =>
      verifyHistory(
        history.map((row, i) =>
          i === 2 ? { ...row, hash: 'rewritten' } : row
        ),
        history
      )
    ).toThrow('migration_history_mismatch');
  });
  it('reports a bounded history sample without claiming its total count', () => {
    const receipts = Array.from(
      { length: MIGRATION_HISTORY_SAMPLE_LIMIT + 1 },
      (_, i) => ({
        hash: i.toString(16).padStart(64, '0'),
        when: String(1_700_000_000_000 + i),
      })
    );
    const expected = receipts.slice(0, 6);
    for (const length of [
      0,
      4,
      7,
      MIGRATION_HISTORY_SAMPLE_LIMIT - 1,
      MIGRATION_HISTORY_SAMPLE_LIMIT,
      MIGRATION_HISTORY_SAMPLE_LIMIT + 1,
    ]) {
      const hold = captureSchemaHold(() =>
        verifyHistory(receipts.slice(0, length), expected)
      );
      expect(hold.reason).toBe('unexpected_migration_count');
      expect(hold.message).toBe('unexpected_migration_count');
      expect(hold.migrationHistory).toEqual({
        sampleLimit: MIGRATION_HISTORY_SAMPLE_LIMIT,
        observedRows: length,
        possiblyTruncated: length >= MIGRATION_HISTORY_SAMPLE_LIMIT,
        rows: receipts.slice(
          0,
          Math.min(length, MIGRATION_HISTORY_SAMPLE_LIMIT)
        ),
      });
    }
  });
  it('masks invalid history values and omits unrelated catalog fields', () => {
    const receipts = Array.from({ length: 6 }, (_, i) => ({
      hash: i.toString(16).padStart(64, '0'),
      when: String(1_700_000_000_000 + i),
    }));
    const secret = 'postgresql://private-user:private-token@private.invalid/db';
    const actual = receipts.map((row, i) =>
      i === 2 ? { hash: secret, when: secret, password: secret } : row
    );
    const hold = captureSchemaHold(() => verifyHistory(actual, receipts));
    expect(hold.reason).toBe('migration_history_mismatch');
    expect(hold.migrationHistory).toEqual({
      sampleLimit: MIGRATION_HISTORY_SAMPLE_LIMIT,
      observedRows: 6,
      possiblyTruncated: false,
      rows: receipts.map((row, i) =>
        i === 2 ? { hash: null, when: null } : row
      ),
    });
    const serialized = JSON.stringify(hold.migrationHistory);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('password');
    for (const invalid of [
      { hash: 'a'.repeat(63), when: '1e12' },
      { hash: 'g'.repeat(64), when: '1.5' },
      { hash: 'a'.repeat(65), when: '1'.repeat(20) },
      { hash: `${'a'.repeat(64)}\n`, when: '123\n' },
    ]) {
      const malformed = captureSchemaHold(() =>
        verifyHistory([invalid, ...receipts.slice(1)], receipts)
      );
      expect(malformed.migrationHistory?.rows[0]).toEqual({
        hash: null,
        when: null,
      });
    }
    const invalidString = captureSchemaHold(() =>
      verifyHistory([{ hash: null, when: '1' }], receipts)
    );
    expect(invalidString.reason).toBe('invalid_string');
    expect(invalidString.migrationHistory).toBeUndefined();
  });
  it('reports only physical feature booleans without asserting release readiness', () => {
    expect(physicalFeeSchemaDiagnostics(columns, index)).toEqual({
      scope: 'app-catalog-physical-shape-only',
      readyForApplication: false,
      columnsMatch: true,
      indexPresent: true,
      indexShapeMatch: true,
    });
    expect(physicalFeeSchemaDiagnostics([], null)).toEqual({
      scope: 'app-catalog-physical-shape-only',
      readyForApplication: false,
      columnsMatch: false,
      indexPresent: false,
      indexShapeMatch: false,
    });
    for (const malformed of [
      undefined,
      null,
      [columns[0]],
      [columns[0], columns[0]],
      [columns[0], { ...columns[1], type: 'varchar' }],
      [columns[0], { ...columns[1], notNull: true }],
      [columns[0], { ...columns[1], hasDefault: true }],
      [columns[0], { ...columns[1], dropped: true }],
      [columns[0], { ...columns[1], table: 'User' }],
    ]) {
      expect(physicalFeeSchemaDiagnostics(malformed, index).columnsMatch).toBe(
        false
      );
    }
    const secret = 'postgresql://private-user:private-token@private.invalid/db';
    const diagnostic = physicalFeeSchemaDiagnostics(
      [
        { ...columns[0], password: secret },
        { ...columns[1], host: secret },
      ],
      { ...index, valid: false, password: secret, oid: secret }
    );
    expect(diagnostic.columnsMatch).toBe(true);
    expect(diagnostic.indexPresent).toBe(true);
    expect(diagnostic.indexShapeMatch).toBe(false);
    expect(diagnostic.readyForApplication).toBe(false);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(Object.keys(diagnostic).sort()).toEqual([
      'columnsMatch',
      'indexPresent',
      'indexShapeMatch',
      'readyForApplication',
      'scope',
    ]);
  });
  it('refuses partial or manually pre-applied columns without a real receipt', () => {
    expect(verifyColumns([], 5)).toBe(false);
    expect(verifyColumns(columns, 6)).toBe(true);
    expect(() => verifyColumns(columns, 5)).toThrow('unreceipted_fee_columns');
    expect(() => verifyColumns(columns.slice(0, 1), 6)).toThrow(
      'receipted_fee_columns_missing'
    );
    expect(() =>
      verifyColumns([{ ...columns[0], hasDefault: true }, columns[1]], 6)
    ).toThrow('incorrect_fee_column');
  });
  it('rejects every incorrect replay backstop instead of dropping or rebuilding it', () => {
    expect(verifyIndex(null)).toBe(false);
    expect(verifyIndex(index)).toBe(true);
    for (const patch of [
      { targetMatches: false },
      { valid: false },
      { ready: false },
      { live: false },
      { unique: false },
      { method: 'hash' },
      { kind: 'I' },
      { keys: 2 },
      { attributes: 2 },
      { noExpressions: false },
      { columns: ['id'] },
      { predicate: null },
    ]) {
      expect(() => verifyIndex({ ...index, ...patch })).toThrow(
        'incorrect_fee_index'
      );
    }
  });
  it('sanitizes malformed connection values without printing them', () => {
    expect(() => endpoint('https://private-token@example.invalid')).toThrow(
      'invalid_database_url'
    );
    expect(() =>
      endpoint('postgresql://app:private@host/game#private')
    ).toThrow('invalid_database_url');
    expect(() => endpoint('private-token')).toThrow('invalid_database_url');
  });
});
