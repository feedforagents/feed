import { createHash } from 'node:crypto';

export class SchemaHold extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export function requireCondition(
  value: boolean,
  reason: string
): asserts value {
  if (!value) throw new SchemaHold(reason);
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
export interface Migration {
  hash: string;
  when: string;
}
export function verifyHistory(value: unknown, expected: Migration[]): number {
  const actual = list(value).map((item) => {
    const row = object(item);
    return { hash: text(row.hash), when: text(row.when) };
  });
  requireCondition(
    expected.length === 6 && [5, 6].includes(actual.length),
    'unexpected_migration_count'
  );
  requireCondition(
    actual.every(
      (row, i) =>
        row.hash === expected[i]?.hash && row.when === expected[i]?.when
    ),
    'migration_history_mismatch'
  );
  return actual.length;
}
export function verifyColumns(value: unknown, historyLength: number): boolean {
  const columns = list(value);
  if (historyLength === 5) {
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
