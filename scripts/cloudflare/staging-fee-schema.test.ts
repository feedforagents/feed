import { describe, expect, it } from 'bun:test';
import {
  endpoint,
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

describe('staging fee schema release boundaries', () => {
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
