/**
 * Starting grant at phone verification — PRD §9.1 [D-11]: "Start:
 * 100 pts per account, once, at phone verification."
 *
 * Unlike the signup-route suites, the funding service here is NOT
 * mocked: both PhoneVerificationService and
 * TradingBalanceFundingService run their real code (conditional
 * phoneVerifiedAt update, user-row lock, welcome-bonus ledger check,
 * balance update, ledger insert) against a stateful in-memory fake of
 * the `@feed/db` handle. The fake interprets the drizzle conditions and
 * balance-increment fragments the services actually build, so the
 * balance/ledger outcomes asserted below are produced by the services'
 * own once-only logic, not by a stubbed return value.
 *
 * The fake serializes `db.transaction` calls. That mirrors what the
 * funding service's `SELECT … FOR UPDATE` row lock guarantees on real
 * Postgres for this access pattern; it does not re-prove Postgres lock
 * semantics, and no live database exists in this environment.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { WELCOME_BONUS_BALANCE_DESCRIPTION } from '@feed/db';
import { getTableColumns } from 'drizzle-orm';

// ─── Stateful fake of the @feed/db handle ─────────────────────────────

type Row = Record<string, unknown>;

interface FakeStore {
  users: Map<string, Row>;
  balanceTransactions: Row[];
}

const store: FakeStore = { users: new Map(), balanceTransactions: [] };

const actualDb = await import('@feed/db');

const columnKeyByTable = new Map<unknown, Map<unknown, string>>();
for (const table of [actualDb.users, actualDb.balanceTransactions]) {
  const byColumn = new Map<unknown, string>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    byColumn.set(column, key);
  }
  columnKeyByTable.set(table, byColumn);
}

function tableRows(table: unknown): Row[] {
  if (table === actualDb.users) return [...store.users.values()];
  if (table === actualDb.balanceTransactions) return store.balanceTransactions;
  throw new Error('fake db: unknown table');
}

function columnKey(table: unknown, column: unknown): string {
  const key = columnKeyByTable.get(table)?.get(column);
  if (!key) throw new Error('fake db: unknown column');
  return key;
}

// ── Drizzle condition / fragment interpretation ──────────────────────

type Token =
  | { kind: 'str'; value: string }
  | { kind: 'col'; column: unknown }
  | { kind: 'param'; value: unknown };

function flattenChunks(chunks: unknown[], out: Token[]): void {
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (typeof chunk !== 'object') {
      out.push({ kind: 'param', value: chunk });
      continue;
    }
    const record = chunk as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      flattenChunks(record.queryChunks as unknown[], out);
    } else if (
      Array.isArray(record.value) &&
      record.value.every((v) => typeof v === 'string')
    ) {
      out.push({ kind: 'str', value: (record.value as string[]).join('') });
    } else if ('name' in record && 'table' in record) {
      out.push({ kind: 'col', column: chunk });
    } else {
      out.push({ kind: 'param', value: record.value ?? chunk });
    }
  }
}

function tokensOf(sqlLike: unknown): Token[] {
  const chunks = (sqlLike as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) throw new Error('fake db: expected a SQL object');
  const out: Token[] = [];
  flattenChunks(chunks, out);
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  return String(a) === String(b);
}

/** Evaluates the eq / isNull / and(...) conditions the services build. */
function matchesCondition(
  table: unknown,
  condition: unknown,
  row: Row
): boolean {
  const tokens = tokensOf(condition);
  let i = 0;
  let result = true;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind !== 'col') {
      i++;
      continue;
    }
    const key = columnKey(table, token.column);
    // Collect the text and param that follow this column reference.
    let text = '';
    let param: unknown;
    let hasParam = false;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      const next = tokens[j]!;
      if (next.kind === 'str') {
        text += next.value;
        if (hasParam) break;
      } else if (next.kind === 'param' && !hasParam) {
        param = next.value;
        hasParam = true;
      } else {
        break;
      }
    }
    if (text.includes('is not null')) {
      result = result && row[key] !== null && row[key] !== undefined;
    } else if (text.includes('is null')) {
      result = result && (row[key] === null || row[key] === undefined);
    } else if (text.includes('=')) {
      result = result && valuesEqual(row[key], param);
    }
    i = Math.max(j, i + 1);
  }
  return result;
}

/** Applies a .set() payload: plain values, or `COALESCE(...) + n` SQL. */
function applySetPayload(row: Row, payload: Row): void {
  for (const [key, value] of Object.entries(payload)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)
    ) {
      const tokens = tokensOf(value);
      const delta = tokens.find(
        (t) => t.kind === 'param' && typeof t.value === 'number'
      );
      if (!delta) throw new Error(`fake db: cannot interpret set for ${key}`);
      row[key] = String(Number(row[key] ?? 0) + Number(delta.value));
    } else {
      row[key] = value;
    }
  }
}

function projectRow(
  table: unknown,
  selection: Record<string, unknown> | undefined,
  row: Row
): Row {
  if (!selection) return { ...row };
  const out: Row = {};
  for (const [alias, column] of Object.entries(selection)) {
    out[alias] = row[columnKey(table, column)];
  }
  return out;
}

// ── Query builders ────────────────────────────────────────────────────

function makeSelect(table: unknown, selection?: Record<string, unknown>) {
  let condition: unknown;
  let limitCount: number | undefined;
  const builder = {
    from: () => builder,
    where: (cond: unknown) => {
      condition = cond;
      return builder;
    },
    limit: (n: number) => {
      limitCount = n;
      return builder;
    },
    for: () => builder,
    orderBy: () => builder,
    then: (
      resolve: (rows: Row[]) => unknown,
      reject?: (err: unknown) => unknown
    ) => {
      let rows = tableRows(table).filter(
        (row) =>
          condition === undefined || matchesCondition(table, condition, row)
      );
      if (limitCount !== undefined) rows = rows.slice(0, limitCount);
      return Promise.resolve(
        rows.map((row) => projectRow(table, selection, row))
      ).then(resolve, reject);
    },
  };
  return builder;
}

function makeUpdate(table: unknown) {
  return {
    set: (payload: Row) => ({
      where: (condition: unknown) => {
        const apply = () =>
          tableRows(table)
            .filter((row) => matchesCondition(table, condition, row))
            .map((row) => {
              applySetPayload(row, payload);
              return row;
            });
        const result = {
          returning: (selection?: Record<string, unknown>) =>
            Promise.resolve(
              apply().map((row) => projectRow(table, selection, row))
            ),
          then: (
            resolve: (rows: Row[]) => unknown,
            reject?: (err: unknown) => unknown
          ) => Promise.resolve(apply()).then(resolve, reject),
        };
        return result;
      },
    }),
  };
}

function makeInsert(table: unknown) {
  return {
    values: (payload: Row) => {
      const row: Row = { createdAt: new Date(), ...payload };
      if (table === actualDb.users) {
        store.users.set(String(payload.id), row);
      } else if (table === actualDb.balanceTransactions) {
        store.balanceTransactions.push(row);
      } else {
        throw new Error('fake db: unknown insert table');
      }
      return {
        returning: (selection?: Record<string, unknown>) =>
          Promise.resolve([projectRow(table, selection, row)]),
        then: (
          resolve: (rows: Row[]) => unknown,
          reject?: (err: unknown) => unknown
        ) => Promise.resolve([row]).then(resolve, reject),
      };
    },
  };
}

let transactionChain: Promise<unknown> = Promise.resolve();

const fakeDb = {
  select: (selection?: Record<string, unknown>) => ({
    from: (table: unknown) => makeSelect(table, selection),
  }),
  update: (table: unknown) => makeUpdate(table),
  insert: (table: unknown) => makeInsert(table),
  transaction: <T>(fn: (tx: typeof fakeDb) => Promise<T>): Promise<T> => {
    const run = transactionChain.then(() => fn(fakeDb));
    transactionChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  },
};

mock.module('@feed/db', () => ({
  ...actualDb,
  db: fakeDb,
}));

const { PhoneVerificationService } = await import(
  '../../api/src/services/phone-verification-service'
);
const { classifyBalanceTransaction } = actualDb;

// ─── Helpers ──────────────────────────────────────────────────────────

function seedUser(id: string, overrides: Row = {}): void {
  store.users.set(id, {
    id,
    virtualBalance: '0',
    totalDeposited: '0',
    totalWithdrawn: '0',
    phoneVerifiedAt: null,
    ...overrides,
  });
}

function userRow(id: string): Row {
  const row = store.users.get(id);
  if (!row) throw new Error(`no seeded user ${id}`);
  return row;
}

function ledgerRowsFor(id: string): Row[] {
  return store.balanceTransactions.filter((row) => row.userId === id);
}

beforeEach(() => {
  store.users.clear();
  store.balanceTransactions.length = 0;
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('starting grant at phone verification (PRD §9.1 [D-11])', () => {
  test('an account that never verifies a phone holds no grant', async () => {
    seedUser('user-1');
    seedUser('user-2');

    // Completing verification for a different account must not leak a
    // grant into this one.
    await PhoneVerificationService.completePhoneVerification('user-2');

    expect(userRow('user-1').phoneVerifiedAt).toBeNull();
    expect(userRow('user-1').virtualBalance).toBe('0');
    expect(userRow('user-1').totalDeposited).toBe('0');
    expect(ledgerRowsFor('user-1')).toHaveLength(0);
  });

  test('pays exactly 100 pts, once, when phone verification completes', async () => {
    seedUser('user-1');

    const result =
      await PhoneVerificationService.completePhoneVerification('user-1');

    expect(result.success).toBe(true);
    expect(result.alreadyVerified).toBe(false);
    expect(result.grantAwarded).toBe(true);
    expect(result.grantAlreadyProcessed).toBe(false);
    expect(result.newBalance).toBe(100);

    expect(userRow('user-1').phoneVerifiedAt).toBeInstanceOf(Date);
    expect(userRow('user-1').virtualBalance).toBe('100');
    expect(userRow('user-1').totalDeposited).toBe('100');

    const ledger = ledgerRowsFor('user-1');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'deposit',
      amount: '100',
      balanceBefore: '0',
      balanceAfter: '100',
      description: WELCOME_BONUS_BALANCE_DESCRIPTION,
    });

    // The paid row still classifies as capital funding.
    const classification = classifyBalanceTransaction({
      type: String(ledger[0]!.type),
      amount: String(ledger[0]!.amount),
      description: String(ledger[0]!.description),
    });
    expect(classification.capitalKind).toBe('external_funding');
    expect(classification.depositReason).toBe('default_wallet_funding');
  });

  test('re-verification never pays twice', async () => {
    seedUser('user-1');
    await PhoneVerificationService.completePhoneVerification('user-1');

    const second =
      await PhoneVerificationService.completePhoneVerification('user-1');
    const third =
      await PhoneVerificationService.completePhoneVerification('user-1');

    for (const repeat of [second, third]) {
      expect(repeat.success).toBe(true);
      expect(repeat.alreadyVerified).toBe(true);
      expect(repeat.grantAwarded).toBe(false);
      expect(repeat.grantAlreadyProcessed).toBe(true);
      expect(repeat.newBalance).toBe(100);
    }
    expect(ledgerRowsFor('user-1')).toHaveLength(1);
    expect(userRow('user-1').virtualBalance).toBe('100');
    expect(userRow('user-1').totalDeposited).toBe('100');
  });

  test('concurrent completion attempts still pay exactly once', async () => {
    seedUser('user-1');

    const results = await Promise.all([
      PhoneVerificationService.completePhoneVerification('user-1'),
      PhoneVerificationService.completePhoneVerification('user-1'),
      PhoneVerificationService.completePhoneVerification('user-1'),
    ]);

    expect(results.every((r) => r.success)).toBe(true);
    expect(results.filter((r) => r.grantAwarded)).toHaveLength(1);
    expect(ledgerRowsFor('user-1')).toHaveLength(1);
    expect(userRow('user-1').virtualBalance).toBe('100');
  });

  test('a verified account missing its grant is paid on a later completion call', async () => {
    // The stranded state a crash between recording the verification and
    // paying the grant would leave behind.
    seedUser('user-1', { phoneVerifiedAt: new Date('2026-01-01T00:00:00Z') });

    const result =
      await PhoneVerificationService.completePhoneVerification('user-1');

    expect(result.success).toBe(true);
    expect(result.alreadyVerified).toBe(true);
    expect(result.grantAwarded).toBe(true);
    expect(ledgerRowsFor('user-1')).toHaveLength(1);
    expect(userRow('user-1').virtualBalance).toBe('100');
  });

  test('unknown user fails without writing anything', async () => {
    const result =
      await PhoneVerificationService.completePhoneVerification('ghost');

    expect(result.success).toBe(false);
    expect(result.error).toBe('User not found');
    expect(store.balanceTransactions).toHaveLength(0);
  });
});
