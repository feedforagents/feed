import { createHash } from 'node:crypto';

export const MIGRATION_HISTORY_SAMPLE_LIMIT = 256;
export interface PhysicalFeeSchemaDiagnostics {
  scope: 'app-catalog-physical-shape-only';
  readyForApplication: false;
  columnsMatch: boolean;
  indexPresent: boolean;
  indexShapeMatch: boolean;
}
export interface MigrationHistoryDiagnostics {
  sampleLimit: typeof MIGRATION_HISTORY_SAMPLE_LIMIT;
  observedRows: number;
  possiblyTruncated: boolean;
  rows: { hash: string | null; when: string | null }[];
  physicalFeature?: PhysicalFeeSchemaDiagnostics;
}
export class SchemaHold extends Error {
  constructor(
    readonly reason: string,
    readonly migrationHistory?: MigrationHistoryDiagnostics
  ) {
    super(reason);
  }
}
export function requireCondition(
  value: boolean,
  reason: string,
  migrationHistory?: MigrationHistoryDiagnostics
): asserts value {
  if (!value) throw new SchemaHold(reason, migrationHistory);
}
export function object(value: unknown): Record<string, unknown> {
  requireCondition(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'invalid_object'
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  requireCondition(
    typeof value === 'string' && value.length > 0,
    'invalid_string'
  );
  return value;
}
export function list(value: unknown): unknown[] {
  requireCondition(Array.isArray(value), 'invalid_array');
  return value;
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export interface Endpoint {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}
export function endpoint(raw: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SchemaHold('invalid_database_url');
  }
  requireCondition(
    ['postgres:', 'postgresql:'].includes(url.protocol) && !url.hash,
    'invalid_database_url'
  );
  let database: string, user: string, password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new SchemaHold('invalid_database_encoding');
  }
  requireCondition(
    !!url.hostname &&
      !!database &&
      !!user &&
      !!password &&
      !/[\r\n\0]/.test(database + user + password),
    'invalid_database_identity'
  );
  const port = Number(url.port || '5432');
  requireCondition(
    Number.isInteger(port) && port > 0 && port <= 65535,
    'invalid_database_port'
  );
  return { host: url.hostname.toLowerCase(), port, database, user, password };
}
export function origin(value: unknown): Omit<Endpoint, 'password'> {
  const row = object(value);
  const port = row.port === undefined ? 5432 : row.port;
  requireCondition(
    typeof port === 'number' &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535,
    'invalid_origin_port'
  );
  requireCondition(
    ['postgres', 'postgresql'].includes(text(row.scheme)),
    'unsupported_origin_scheme'
  );
  return {
    host: text(row.host).toLowerCase(),
    port,
    database: text(row.database),
    user: text(row.user),
  };
}
export function sameDatabase(
  a: Omit<Endpoint, 'password'>,
  b: Omit<Endpoint, 'password'>
): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}
export function verifyEndpoints(
  app: Endpoint,
  direct: Endpoint,
  staging: Omit<Endpoint, 'password'>,
  production: Omit<Endpoint, 'password'>
) {
  requireCondition(
    sameDatabase(app, staging) && app.user === staging.user,
    'app_origin_identity_mismatch'
  );
  requireCondition(
    sameDatabase(app, direct),
    'direct_origin_identity_mismatch'
  );
  requireCondition(
    !sameDatabase(staging, production),
    'staging_equals_production'
  );
}
// Approved staging-only lineage. These are original file hashes/timestamps,
// not receipts for the deliberately deferred 0001/0002 removals.
export const STAGING_ORIGINAL_MIGRATIONS = [
  {
    index: 0,
    tag: '0000_fresh_baseline',
    hash: '69975b14b733c8134362897a91ef4d94ae945c6778776c6c11906281709c59c0',
    when: '1791752210564',
  },
  {
    index: 1,
    tag: '0001_remove_farcaster',
    hash: '2dcec6ddeac6edc27531fad767f613d9f15050a68d0e7051036e174e68c5d618',
    when: '1791754582384',
  },
  {
    index: 2,
    tag: '0002_remove_collectible_nfts',
    hash: '58624cfb049611990db828c68afc0ed24aa289b68cbb20e7f5fc0ba7341b836d',
    when: '1791756357957',
  },
  {
    index: 3,
    tag: '0003_prediction_cash_cost_basis',
    hash: '9a6e966b25944817cc02cf2505e6d226d4e825332c50b5451bbc2a7c11ca1ea3',
    when: '1793815597156',
  },
  {
    index: 4,
    tag: '0004_leverage_cap_20',
    hash: '7239f1c02196404bc8b2d3242d760f8a3cc4fe0031d5c5e12c1ce4011a7cebc9',
    when: '1793818723317',
  },
  {
    index: 5,
    tag: '0005_trading_fee_idempotency_key',
    hash: '48f477940d238aaa5b8dbef8463a222cadb065292cb6ca3393b2e1238b73b583',
    when: '1794307141641',
  },
] as const;
export const BASELINE_ADDITIVE_MIGRATIONS = [
  STAGING_ORIGINAL_MIGRATIONS[0],
  STAGING_ORIGINAL_MIGRATIONS[3],
  STAGING_ORIGINAL_MIGRATIONS[4],
  STAGING_ORIGINAL_MIGRATIONS[5],
] as const;
export interface Migration {
  hash: string;
  when: string;
}
export function verifyHistory(
  value: unknown,
  expected: Migration[],
  allowStagingBaselineAdditive = false
): number {
  const actual = list(value).map((item) => {
    const row = object(item);
    return { hash: text(row.hash), when: text(row.when) };
  });
  // This is the bounded existing catalog sample, not a total count.
  const migrationHistory: MigrationHistoryDiagnostics = {
    sampleLimit: MIGRATION_HISTORY_SAMPLE_LIMIT,
    observedRows: actual.length,
    possiblyTruncated: actual.length >= MIGRATION_HISTORY_SAMPLE_LIMIT,
    rows: actual.slice(0, MIGRATION_HISTORY_SAMPLE_LIMIT).map((row) => ({
      hash:
        row.hash.length === 64 && /^[a-f0-9]{64}$/i.test(row.hash)
          ? row.hash
          : null,
      when:
        row.when === row.when.trim() && /^-?\d{1,19}$/.test(row.when)
          ? row.when
          : null,
    })),
  };
  const additive =
    allowStagingBaselineAdditive && [1, 4].includes(actual.length);
  requireCondition(
    expected.length === 6 && ([5, 6].includes(actual.length) || additive),
    'unexpected_migration_count',
    migrationHistory
  );
  if (additive) {
    requireCondition(
      STAGING_ORIGINAL_MIGRATIONS.every(
        (pin) =>
          expected[pin.index]?.hash === pin.hash &&
          expected[pin.index]?.when === pin.when
      ),
      'unsupported_additive_source'
    );
    const selected =
      actual.length === 1
        ? BASELINE_ADDITIVE_MIGRATIONS.slice(0, 1)
        : BASELINE_ADDITIVE_MIGRATIONS;
    requireCondition(
      actual.every(
        (row, i) =>
          row.hash === selected[i]?.hash && row.when === selected[i]?.when
      ),
      'migration_history_mismatch',
      migrationHistory
    );
  } else {
    requireCondition(
      actual.every(
        (row, i) =>
          row.hash === expected[i]?.hash && row.when === expected[i]?.when
      ),
      'migration_history_mismatch',
      migrationHistory
    );
  }
  return actual.length;
}
export function verifyColumns(
  value: unknown,
  historyLength: number,
  allowStagingBaselineAdditive = false
): boolean {
  const columns = list(value);
  if (
    historyLength === 5 ||
    (allowStagingBaselineAdditive && historyLength === 1)
  ) {
    requireCondition(columns.length === 0, 'unreceipted_fee_columns');
    return false;
  }
  requireCondition(columns.length === 2, 'receipted_fee_columns_missing');
  const names = columns
    .map((value) => {
      const c = object(value);
      requireCondition(
        c.type === 'text' &&
          c.notNull === false &&
          c.hasDefault === false &&
          c.dropped === false,
        'incorrect_fee_column'
      );
      return text(c.table);
    })
    .sort();
  requireCondition(
    JSON.stringify(names) ===
      JSON.stringify(['TradingFee', 'TradingFeeOutbox']),
    'incorrect_fee_tables'
  );
  return true;
}
export function verifyIndex(value: unknown): boolean {
  if (value === null) return false;
  const row = object(value);
  requireCondition(
    row.targetMatches === true &&
      row.method === 'btree' &&
      row.kind === 'i' &&
      row.unique === true &&
      row.valid === true &&
      row.ready === true &&
      row.live === true &&
      row.keys === 1 &&
      row.attributes === 1 &&
      row.noExpressions === true &&
      JSON.stringify(row.columns) === '["idempotencyKey"]' &&
      row.predicate === '("idempotencyKey" IS NOT NULL)',
    'incorrect_fee_index'
  );
  return true;
}

export const BASELINE_ADDITIVE_TABLES = [
  'PerpMarketSnapshot',
  'Position',
  'TradingFee',
  'TradingFeeOutbox',
] as const;

export function verifyAdditiveTargets(
  value: unknown,
  requireOwnership = false
): Record<string, string> {
  const rows = list(value).map(object);
  requireCondition(
    rows.length === 4 &&
      JSON.stringify(rows.map((row) => row.table).sort()) ===
        JSON.stringify(BASELINE_ADDITIVE_TABLES),
    'incorrect_additive_targets'
  );
  const targets: Record<string, string> = {};
  for (const table of BASELINE_ADDITIVE_TABLES) {
    const row = rows.find((row) => row.table === table);
    requireCondition(row !== undefined, 'incorrect_additive_targets');
    const oid = text(row.oid);
    requireCondition(
      oid === oid.trim() &&
        /^[1-9]\d{0,9}$/.test(oid) &&
        Number(oid) <= 4_294_967_295 &&
        row.schema === 'public' &&
        row.kind === 'r' &&
        row.resolvesPublic === true &&
        typeof row.canMigrate === 'boolean',
      'incorrect_additive_targets'
    );
    requireCondition(
      !requireOwnership || row.canMigrate === true,
      'migration_role_not_owner'
    );
    targets[table] = oid;
  }
  requireCondition(
    new Set(Object.values(targets)).size === 4,
    'incorrect_additive_targets'
  );
  return targets;
}

export function verifyAdditiveColumns(
  value: unknown,
  historyLength: number
): void {
  requireCondition(
    [1, 4].includes(historyLength),
    'unexpected_additive_history'
  );
  const rows = list(value).map(object);
  const basis = rows.filter(
    (row) => row.table === 'Position' && row.column === 'cashCostBasis'
  );
  const leverage = rows.filter(
    (row) => row.table === 'PerpMarketSnapshot' && row.column === 'maxLeverage'
  );
  requireCondition(
    basis.length === (historyLength === 1 ? 0 : 1) &&
      leverage.length === 1 &&
      rows.length === basis.length + leverage.length,
    'unsupported_additive_columns'
  );
  const limit = leverage[0];
  requireCondition(
    limit?.type === 'integer' &&
      limit.notNull === true &&
      limit.hasDefault === true &&
      limit.dropped === false &&
      (historyLength === 1
        ? ['100', '20'].includes(text(limit.defaultExpression))
        : limit.defaultExpression === '20'),
    'incorrect_leverage_column'
  );
  if (historyLength === 4) {
    const cost = basis[0];
    requireCondition(
      cost?.type === 'numeric(18,2)' &&
        cost.notNull === false &&
        cost.hasDefault === false &&
        cost.defaultExpression === null &&
        cost.dropped === false,
      'incorrect_cost_basis_column'
    );
  }
}

// Diagnostic-only physical shape; this proves no history, identity or RLS access.
export function physicalFeeSchemaDiagnostics(
  columns: unknown,
  index: unknown
): PhysicalFeeSchemaDiagnostics {
  const columnsMatch =
    Array.isArray(columns) &&
    columns.length === 2 &&
    ['TradingFee', 'TradingFeeOutbox'].every(
      (table) =>
        columns.filter((column: unknown) => {
          if (
            typeof column !== 'object' ||
            column === null ||
            Array.isArray(column)
          ) {
            return false;
          }
          const row = column as Record<string, unknown>;
          return (
            row.table === table &&
            row.type === 'text' &&
            row.notNull === false &&
            row.hasDefault === false &&
            row.dropped === false
          );
        }).length === 1
    );
  let indexShapeMatch = false;
  try {
    indexShapeMatch = verifyIndex(index);
  } catch (error) {
    if (!(error instanceof SchemaHold)) throw error;
  }
  return {
    scope: 'app-catalog-physical-shape-only',
    readyForApplication: false,
    columnsMatch,
    indexPresent: index !== null && index !== undefined,
    indexShapeMatch,
  };
}
