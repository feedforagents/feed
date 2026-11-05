/**
 * In-memory fake for the `@feed/db` surface used by
 * TradingBalanceFundingService (reversePurchaseFunding / creditDisputeWon).
 *
 * The service issues drizzle-style chained queries; the fake evaluates the
 * `eq`/`and` predicates against in-memory rows and interprets the four
 * `sql` balance expressions the service uses (clamped subtract / add).
 *
 * The fake module factory is registered with `mock.module('@feed/db', ...)`
 * in the test file (the repo's standard pattern). Test helpers below share
 * the same module-scope state, so tests can seed users and read balances.
 */

type UserRow = {
  id: string;
  virtualBalance: number;
  totalWithdrawn: number;
  totalDeposited: number;
};
type TxnRow = Record<string, unknown> & {
  id: string;
  userId: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  relatedId: string | null;
  description: string | null;
  createdAt: Date;
};

const state = {
  users: new Map<string, UserRow>(),
  txns: [] as TxnRow[],
};

export function resetFakeDb() {
  state.users.clear();
  state.txns = [];
}

export function seedFakeUser(
  id: string,
  balance: number,
  deposited: number,
  withdrawn: number
) {
  state.users.set(id, {
    id,
    virtualBalance: balance,
    totalWithdrawn: withdrawn,
    totalDeposited: deposited,
  });
}

export function getFakeUser(id: string): UserRow {
  const u = state.users.get(id);
  if (!u) throw new Error(`no fake user ${id}`);
  return u;
}

export function getFakeTxns(): TxnRow[] {
  return state.txns.map((t) => ({ ...t }));
}

type Pred =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'and'; conds: Pred[] };

function evalPred(
  pred: Pred | undefined,
  row: Record<string, unknown>
): boolean {
  if (!pred) return true;
  if (pred.kind === 'eq') return row[pred.col] === pred.val;
  return pred.conds.every((c) => evalPred(c, row));
}

type SqlMarker = { __sql: true; strings: readonly string[]; values: unknown[] };
function sqlTag(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlMarker {
  return { __sql: true, strings, values };
}
function isSqlMarker(v: unknown): v is SqlMarker {
  return typeof v === 'object' && v !== null && (v as SqlMarker).__sql === true;
}

/** Interpret the service's balance expressions (clamped subtract / add). */
function applyExpr(current: number, value: unknown): number {
  if (!isSqlMarker(value)) return Number(value);
  const text = value.strings.join('\0');
  const v = Number(value.values[0]);
  if (text.includes('+')) return current + v;
  if (text.includes('-')) return Math.max(0, current - v);
  return current;
}

class Query {
  private table: 'users' | 'balanceTransactions' | null = null;
  private projection: Record<string, string> | null = null;
  private pred: Pred | undefined;
  private sortDesc: string | null = null;
  private limitN: number | null = null;

  select(projection: Record<string, string>) {
    this.projection = projection;
    return this;
  }
  from(table: { __table: 'users' | 'balanceTransactions' }) {
    this.table = table.__table;
    return this;
  }
  where(pred: Pred) {
    this.pred = pred;
    return this;
  }
  orderBy(order: { kind: 'desc'; col: string }) {
    this.sortDesc = order.col;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  for(_mode: string) {
    return this;
  }
  then(
    resolve: (rows: Array<Record<string, unknown>>) => void,
    reject: (err: unknown) => void
  ) {
    try {
      resolve(this.run());
    } catch (err) {
      reject(err);
    }
  }
  private run(): Array<Record<string, unknown>> {
    let rows: Array<Record<string, unknown>> =
      this.table === 'users'
        ? [...state.users.values()].map((u) => ({ ...u }))
        : state.txns.map((t) => ({ ...t }));
    rows = rows.filter((r) => evalPred(this.pred, r));
    if (this.sortDesc) {
      const col = this.sortDesc;
      rows.sort((a, b) => {
        const av =
          a[col] instanceof Date ? (a[col] as Date).getTime() : Number(a[col]);
        const bv =
          b[col] instanceof Date ? (b[col] as Date).getTime() : Number(b[col]);
        return bv - av;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    if (this.projection) {
      rows = rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [key, col] of Object.entries(this.projection!))
          out[key] = r[col];
        return out;
      });
    }
    return rows;
  }
}

class UpdateBuilder {
  constructor(private fields: Record<string, unknown>) {}
  where(pred: Pred) {
    for (const row of [...state.users.values()]) {
      if (!evalPred(pred, row as unknown as Record<string, unknown>)) continue;
      for (const [key, value] of Object.entries(this.fields)) {
        (row as unknown as Record<string, unknown>)[key] = applyExpr(
          Number((row as unknown as Record<string, unknown>)[key] ?? 0),
          value
        );
      }
    }
    return Promise.resolve();
  }
}

const fakeTx = {
  select: (projection: Record<string, string>) =>
    new Query().select(projection),
  update: (_table: { __table: 'users' }) => ({
    set: (fields: Record<string, unknown>) => new UpdateBuilder(fields),
  }),
  insert: (_table: { __table: 'balanceTransactions' }) => ({
    values: (row: Record<string, unknown>) => {
      state.txns.push({
        ...(row as unknown as TxnRow),
        createdAt: (row.createdAt as Date) ?? new Date(),
      });
      return Promise.resolve();
    },
  }),
};

const usersTable = {
  __table: 'users' as const,
  id: 'id',
  virtualBalance: 'virtualBalance',
  totalWithdrawn: 'totalWithdrawn',
  totalDeposited: 'totalDeposited',
};
const balanceTransactionsTable = {
  __table: 'balanceTransactions' as const,
  id: 'id',
  userId: 'userId',
  type: 'type',
  amount: 'amount',
  balanceBefore: 'balanceBefore',
  balanceAfter: 'balanceAfter',
  relatedId: 'relatedId',
  description: 'description',
  createdAt: 'createdAt',
};

export function fakeFeedDbModule() {
  return {
    and: (...conds: Pred[]) => ({ kind: 'and', conds }) as Pred,
    balanceTransactions: balanceTransactionsTable,
    db: {
      select: (projection: Record<string, string>) =>
        new Query().select(projection),
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx),
    },
    desc: (col: string) => ({ kind: 'desc', col }),
    eq: (col: string, val: unknown) => ({ kind: 'eq', col, val }) as Pred,
    inArray: (col: string, vals: unknown[]) => ({ kind: 'inArray', col, vals }),
    sql: sqlTag,
    users: usersTable,
    WELCOME_BONUS_BALANCE_DESCRIPTION: 'welcome-bonus',
  };
}
