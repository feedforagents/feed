/**
 * Run the shipped manual index step against an explicitly disposable loopback
 * database. Existing correct indexes are restored; unknown object replacements
 * refuse cleanup. Rows belong to this suite only after successful RETURNING.
 * No remote/shared database or automatic invalid-index recovery is supported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const databaseUrl =
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
const target = new URL(databaseUrl);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
  !/^\/(test_db|feed_pr\d+)$/.test(target.pathname) ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL !== databaseUrl)
)
  throw new Error(
    'Index DDL requires one explicit disposable loopback test database'
  );
// A single connection makes each test's search_path deterministic. Each manual
// statement still uses autocommit, never a transaction around CONCURRENTLY.
const pg = postgres(databaseUrl, { max: 1, prepare: false });
const MANUAL_0005B = new URL(
  '../../db/drizzle/migrations/manual/0005b_trading_fee_idempotency_key_idx_concurrently.sql',
  import.meta.url
);
const run = crypto.randomUUID().replaceAll('-', '');
const userId = `idx-user-${run}`;
interface OwnedRow {
  id: string;
  rowJson: string;
}
interface IndexState {
  oid: string;
  tableOid: string;
  method: string;
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  indislive: boolean;
  indnkeyatts: number;
  indnatts: number;
  noExpressions: boolean;
  predicate: string | null;
  keyColumns: string[];
}
let tableOid: string | undefined;
let scopeVerified = false;
let fixtureReady = false;
let indexLease: { oid: string; tableOid: string } | undefined;
const ownedUsers: OwnedRow[] = [];
const ownedFees: OwnedRow[] = [];

async function readIndex(): Promise<IndexState | undefined> {
  const rows = await pg<IndexState[]>`
    SELECT i.oid::text AS oid, ix.indrelid::text AS "tableOid", am.amname AS method,
      ix.indisunique, ix.indisvalid, ix.indisready, ix.indislive,
      ix.indnkeyatts, ix.indnatts, ix.indexprs IS NULL AS "noExpressions",
      pg_catalog.pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum,ord)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum
        ORDER BY k.ord) AS "keyColumns"
    FROM pg_catalog.pg_class i
    JOIN pg_catalog.pg_index ix ON ix.indexrelid=i.oid
    JOIN pg_catalog.pg_am am ON am.oid=i.relam
    WHERE i.oid=pg_catalog.to_regclass('public."TradingFee_idempotencyKey_idx"')
  `;
  return rows[0];
}
function healthy(state: IndexState | undefined): boolean {
  return (
    !!state &&
    state.tableOid === tableOid &&
    state.method === 'btree' &&
    state.indisunique &&
    state.indisvalid &&
    state.indisready &&
    state.indislive &&
    state.indnkeyatts === 1 &&
    state.indnatts === 1 &&
    state.noExpressions &&
    state.keyColumns.length === 1 &&
    state.keyColumns[0] === 'idempotencyKey' &&
    state.predicate === '("idempotencyKey" IS NOT NULL)'
  );
}
async function captureIndexLease() {
  const state = await readIndex();
  if (!state) throw new Error('Expected acquired disposable index');
  indexLease = { oid: state.oid, tableOid: state.tableOid };
}
async function dropLeasedIndex() {
  if (!scopeVerified) throw new Error('Disposable database was not verified');
  const state = await readIndex();
  if (
    state &&
    (!indexLease ||
      state.oid !== indexLease.oid ||
      state.tableOid !== indexLease.tableOid)
  ) {
    throw new Error('Refusing to drop an unowned replacement index');
  }
  if (state)
    await pg.unsafe(
      'DROP INDEX CONCURRENTLY public."TradingFee_idempotencyKey_idx"'
    );
  indexLease = undefined;
}
async function restoreIndex() {
  await dropLeasedIndex();
  await runManualStep();
  await captureIndexLease();
  if (!healthy(await readIndex()))
    throw new Error('Disposable index restoration failed');
}
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
async function relationOid(name: string): Promise<string | undefined> {
  const [row] = await pg<{ oid: string | null }[]>`
    SELECT pg_catalog.to_regclass(${name})::oid::text AS oid
  `;
  return row?.oid ?? undefined;
}

beforeAll(async () => {
  const [identity] = await pg<
    {
      database: string;
      address: string;
      replica: boolean;
      tableOid: string | null;
      feeRows: number;
    }[]
  >`
    SELECT current_database() AS database, pg_catalog.host(inet_server_addr()) AS address,
      pg_is_in_recovery() AS replica,
      pg_catalog.to_regclass('public."TradingFee"')::oid::text AS "tableOid",
      (SELECT count(*)::int FROM public."TradingFee") AS "feeRows"
  `;
  if (
    !identity ||
    '/' + identity.database !== target.pathname ||
    !['127.0.0.1', '::1'].includes(identity.address) ||
    identity.replica ||
    !identity.tableOid ||
    identity.feeRows !== 0
  ) {
    throw new Error(
      'Index DDL requires an empty fee table in the verified disposable primary'
    );
  }
  tableOid = identity.tableOid;
  const initial = await readIndex();
  if (initial && !healthy(initial))
    throw new Error('Refusing an unknown initial index; reconcile manually');
  // A correct baseline index may be replaced only inside this explicitly
  // disposable empty DB. Pin every replacement OID and restore it after each case.
  if (initial) indexLease = { oid: initial.oid, tableOid: initial.tableOid };
  scopeVerified = true;
});

/**
 * Split a SQL script at statement boundaries the way psql does before
 * sending statements one by one: semicolons inside line comments,
 * single-quoted strings and dollar-quoted bodies do not split.
 */
function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarTag: string | null = null;
  let i = 0;
  while (i < script.length) {
    const ch = script[i] as string;
    if (dollarTag) {
      if (script.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i++;
      }
      continue;
    }
    if (ch === '-' && script[i + 1] === '-') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? script.length : end;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      current += ch;
      i++;
      while (i < script.length) {
        current += script[i];
        if (script[i] === "'") {
          if (script[i + 1] === "'") {
            current += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(script.slice(i));
      if (match) {
        dollarTag = match[0];
        current += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Run the shipped manual step (build + self-verification), one
 * statement per simple-protocol query so CONCURRENTLY stays outside
 * any transaction block, exactly as `psql -f` runs it.
 */
async function runManualStep(): Promise<void> {
  const content = readFileSync(MANUAL_0005B, 'utf-8');
  for (const statement of splitStatements(content)) {
    await pg.unsafe(statement);
  }
}

describe('trading fee idempotency index (manual 0005b)', () => {
  it('verifies a correct index on a populated table', async () => {
    ownedUsers.push(
      ...(await pg<OwnedRow[]>`
      WITH acquired AS (INSERT INTO public."User"
        (id,username,"updatedAt") VALUES (${userId},${`idx-verify-${run}`},now()) RETURNING *)
      SELECT id,to_jsonb(acquired)::text AS "rowJson" FROM acquired
    `)
    );
    ownedFees.push(
      ...(await pg<OwnedRow[]>`
      WITH acquired AS (INSERT INTO public."TradingFee"
        (id,"userId","tradeType","feeAmount","platformFee","referrerFee","idempotencyKey")
        SELECT ${`idx-pop-${run}-`} || n, ${userId}, 'pred_buy', 1, 1, 0,
          CASE WHEN n % 2=0 THEN ${`idx-key-${run}-`} || n ELSE NULL END
        FROM generate_series(0,999) n RETURNING *)
      SELECT id,to_jsonb(acquired)::text AS "rowJson" FROM acquired
    `)
    );
    expect(ownedUsers).toHaveLength(1);
    expect(ownedFees).toHaveLength(1000);
    await runManualStep();
    await captureIndexLease();
    const state = await readIndex();
    expect(state).toBeDefined();
    expect(state?.indisunique).toBe(true);
    expect(state?.indisvalid).toBe(true);
    expect(state?.indisready).toBe(true);
    expect(state?.indislive).toBe(true);
    expect(state?.keyColumns).toEqual(['idempotencyKey']);
    expect(state?.predicate).toContain('"idempotencyKey" IS NOT NULL');
    expect(healthy(state)).toBe(true);
    fixtureReady = true;
  });

  it('refuses a same-name index that is not unique', async () => {
    expect(fixtureReady).toBe(true);
    await dropLeasedIndex();
    try {
      await pg.unsafe(
        'CREATE INDEX "TradingFee_idempotencyKey_idx" ON public."TradingFee" USING btree ("idempotencyKey")'
      );
      await captureIndexLease();
      await expect(runManualStep()).rejects.toThrow(/not unique/);
    } finally {
      await restoreIndex();
    }
    expect(healthy(await readIndex())).toBe(true);
  });

  it('refuses a same-name composite expression index', async () => {
    expect(fixtureReady).toBe(true);
    await dropLeasedIndex();
    try {
      await pg.unsafe(
        'CREATE UNIQUE INDEX "TradingFee_idempotencyKey_idx" ON public."TradingFee" USING btree ("idempotencyKey", lower("id")) WHERE "idempotencyKey" IS NOT NULL'
      );
      await captureIndexLease();
      await expect(runManualStep()).rejects.toThrow(
        /composite or expression index/
      );
    } finally {
      await restoreIndex();
    }
    expect(healthy(await readIndex())).toBe(true);
  });

  it('builds the public index despite same-name objects earlier in search_path', async () => {
    expect(fixtureReady).toBe(true);
    await dropLeasedIndex();
    await withShadow(async () => {
      await runManualStep();
      await captureIndexLease();
      expect(healthy(await readIndex())).toBe(true);
    });
  });

  it('refuses a public same-name index on another table despite a healthy schema shadow', async () => {
    expect(fixtureReady).toBe(true);
    await dropLeasedIndex();
    const other = `idx_other_${run}`;
    let created = false;
    let otherOid: string | undefined;
    try {
      await pg.unsafe(
        `CREATE TABLE public.${identifier(other)} (id text PRIMARY KEY, "idempotencyKey" text)`
      );
      created = true;
      otherOid = await relationOid(`public.${identifier(other)}`);
      await pg.unsafe(
        `CREATE UNIQUE INDEX "TradingFee_idempotencyKey_idx" ON public.${identifier(other)} ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`
      );
      await captureIndexLease();
      await withShadow(async () => {
        await expect(runManualStep()).rejects.toThrow(
          /exact public.*TradingFee.*another table/
        );
      });
    } finally {
      await dropLeasedIndex();
      if (created) {
        if (
          !otherOid ||
          (await relationOid(`public.${identifier(other)}`)) !== otherOid
        ) {
          throw new Error('Other-table identity changed; preserve it');
        }
        const [row] = await pg.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM public.${identifier(other)}`
        );
        if (row?.count !== 0)
          throw new Error('Other-table rows were not acquired; preserve them');
        await pg.unsafe(`DROP TABLE public.${identifier(other)} RESTRICT`);
      }
      await runManualStep();
      await captureIndexLease();
    }
    expect(healthy(await readIndex())).toBe(true);
  });
});

async function withShadow(body: () => Promise<void>) {
  const name = `idx_shadow_${run}`;
  const qualified = `${identifier(name)}."TradingFee"`;
  let schemaCreated = false;
  let tableCreated = false;
  let shadowTableOid: string | undefined;
  let shadowSchemaOid: string | undefined;
  let shadowIndexOid: string | undefined;
  let control: OwnedRow[] = [];
  try {
    await pg.unsafe(`CREATE SCHEMA ${identifier(name)}`);
    schemaCreated = true;
    const [namespace] = await pg<
      { oid: string }[]
    >`SELECT oid::text AS oid FROM pg_catalog.pg_namespace WHERE nspname=${name}`;
    shadowSchemaOid = namespace?.oid;
    await pg.unsafe(
      `CREATE TABLE ${qualified} (id text PRIMARY KEY, "idempotencyKey" text)`
    );
    tableCreated = true;
    shadowTableOid = await relationOid(qualified);
    control = await pg.unsafe<OwnedRow[]>(
      `WITH acquired AS (INSERT INTO ${qualified} VALUES ($1,$2) RETURNING *) SELECT id,to_jsonb(acquired)::text AS "rowJson" FROM acquired`,
      [`shadow-${run}`, `shadow-key-${run}`]
    );
    await pg.unsafe(
      `CREATE UNIQUE INDEX "TradingFee_idempotencyKey_idx" ON ${qualified} ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`
    );
    const [before] = await pg<
      { oid: string }[]
    >`SELECT pg_catalog.to_regclass(${`${name}."TradingFee_idempotencyKey_idx"`})::oid::text AS oid`;
    shadowIndexOid = before?.oid;
    await pg.unsafe(`SET search_path TO ${identifier(name)}, public`);
    await body();
    const [after] = await pg<
      { oid: string }[]
    >`SELECT pg_catalog.to_regclass(${`${name}."TradingFee_idempotencyKey_idx"`})::oid::text AS oid`;
    expect(after?.oid).toBe(before?.oid);
  } finally {
    await pg.unsafe('SET search_path TO public');
    if (tableCreated) {
      if (
        !shadowTableOid ||
        (await relationOid(qualified)) !== shadowTableOid
      ) {
        throw new Error('Shadow table identity changed; preserve it');
      }
      const currentIndex = await relationOid(
        `${identifier(name)}."TradingFee_idempotencyKey_idx"`
      );
      if (currentIndex !== shadowIndexOid)
        throw new Error('Shadow index identity changed; preserve it');
      const rows = await pg.unsafe<OwnedRow[]>(
        `SELECT id,to_jsonb(t)::text AS "rowJson" FROM ${qualified} t ORDER BY id`
      );
      if (JSON.stringify(rows) !== JSON.stringify(control))
        throw new Error('Shadow control changed; preserve it for diagnosis');
      await pg.unsafe(`DROP TABLE ${qualified} RESTRICT`);
    }
    if (schemaCreated) {
      const [namespace] = await pg<
        { oid: string }[]
      >`SELECT oid::text AS oid FROM pg_catalog.pg_namespace WHERE nspname=${name}`;
      if (!shadowSchemaOid || namespace?.oid !== shadowSchemaOid)
        throw new Error('Shadow schema identity changed; preserve it');
      await pg.unsafe(`DROP SCHEMA ${identifier(name)} RESTRICT`);
    }
  }
}

afterAll(async () => {
  const failures: Error[] = [];
  if (scopeVerified) {
    try {
      if (ownedFees.length) {
        const json = '[' + ownedFees.map((row) => row.rowJson).join(',') + ']';
        await pg`DELETE FROM public."TradingFee" t USING jsonb_array_elements(${json}::text::jsonb) saved
          WHERE t.id=saved->>'id' AND to_jsonb(t)=saved`;
        const left =
          await pg`SELECT id FROM public."TradingFee" WHERE id=ANY(${ownedFees.map((row) => row.id)}::text[])`;
        if (left.length) throw new Error('Owned fee tuples changed or remain');
        ownedFees.length = 0;
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error('Fee cleanup failed')
      );
    }
    try {
      if (ownedUsers.length) {
        const json = '[' + ownedUsers.map((row) => row.rowJson).join(',') + ']';
        await pg`DELETE FROM public."User" u USING jsonb_array_elements(${json}::text::jsonb) saved
          WHERE u.id=saved->>'id' AND to_jsonb(u)=saved
          AND NOT EXISTS (SELECT 1 FROM public."TradingFee" f WHERE f."userId"=u.id)
          AND NOT EXISTS (SELECT 1 FROM public."GameOnboarding" x WHERE x."userId"=u.id)
          AND NOT EXISTS (SELECT 1 FROM public."UserPnLSnapshot" x WHERE x."userId"=u.id)
          AND NOT EXISTS (SELECT 1 FROM public."Whitelist" x WHERE x."userId"=u.id OR x."grantedBy"=u.id)
          AND NOT EXISTS (SELECT 1 FROM public."WhitelistConfig" x WHERE x."updatedBy"=u.id)`;
        const left =
          await pg`SELECT id FROM public."User" WHERE id=ANY(${ownedUsers.map((row) => row.id)}::text[])`;
        if (left.length)
          throw new Error(
            'Owned users changed or have foreign references; preserve them'
          );
        ownedUsers.length = 0;
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error('User cleanup failed')
      );
    }
  }
  if (scopeVerified && fixtureReady) {
    try {
      // Build/reuse only: never drop an unknown or invalid index during teardown.
      await runManualStep();
      await captureIndexLease();
      if (!healthy(await readIndex()))
        throw new Error('Verified index was not restored');
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error('Index restoration failed')
      );
    }
  }
  try {
    await pg.end();
  } catch (error) {
    failures.push(
      error instanceof Error ? error : new Error('Connection close failed')
    );
  }
  if (failures.length)
    throw new AggregateError(failures, 'Index fixture cleanup incomplete');
});
