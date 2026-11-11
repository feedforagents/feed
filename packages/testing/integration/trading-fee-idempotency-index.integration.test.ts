/**
 * Manual 0005b step: the partial unique index on
 * TradingFee.idempotencyKey and its self-verification (round 5 of #1586;
 * round 6 adds the composite-expression rejection).
 *
 * The verification reads pg_index directly because pg_indexes.indexdef
 * cannot prove CONCURRENTLY was used, and IF NOT EXISTS silently accepts
 * an existing index of the same name even when it is invalid or wrong
 * (an interrupted build leaves an INVALID index behind). These tests run
 * the shipped file's statements verbatim against a populated table,
 * split only at statement boundaries and sent one by one over the
 * simple protocol (postgres-js `unsafe`), mirroring `psql -f`:
 * Drizzle's execute() sends a multi-statement string inside a
 * transaction block, where CREATE INDEX CONCURRENTLY is rejected.
 *
 * Requires DATABASE_URL (PostgreSQL 16+). The valid index is left in
 * place afterwards: the migrated schema plus this verified index is a
 * prerequisite for every new application instance (see the 0005b
 * header).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { db, eq, sql, tradingFees, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';

const pg = postgres(process.env.DATABASE_URL ?? '');

const MANUAL_0005B = new URL(
  '../../db/drizzle/migrations/manual/0005b_trading_fee_idempotency_key_idx_concurrently.sql',
  import.meta.url
);

const INDEX_NAME = 'TradingFee_idempotencyKey_idx';

interface IndexState {
  relname: string;
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  predicate: string | null;
  keyColumns: string[];
}

async function readIndex(): Promise<IndexState | undefined> {
  const rows = (await db.execute(sql`
    SELECT i.relname,
      ix.indisunique, ix.indisvalid, ix.indisready,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a
           ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS "keyColumns"
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE i.relname = ${INDEX_NAME} AND t.relname = 'TradingFee'
  `)) as unknown as Array<IndexState>;
  return rows[0];
}

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

const userId = await generateSnowflakeId();

describe('trading fee idempotency index (manual 0005b)', () => {
  it('verifies a correct index on a populated table', async () => {
    await db.insert(users).values({
      id: userId,
      username: `idx-verify-${userId.slice(-10)}`,
      profileComplete: true,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    await db.insert(tradingFees).values(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `idx-pop-${userId.slice(-6)}-${i}`,
        userId,
        tradeType: 'pred_buy',
        feeAmount: '1',
        platformFee: '1',
        referrerFee: '0',
        idempotencyKey: i % 2 === 0 ? `idx-key-${i}` : null,
      }))
    );

    await runManualStep();

    const state = await readIndex();
    expect(state).toBeDefined();
    expect(state?.indisunique).toBe(true);
    expect(state?.indisvalid).toBe(true);
    expect(state?.indisready).toBe(true);
    expect(state?.keyColumns).toEqual(['idempotencyKey']);
    expect(state?.predicate).toContain('"idempotencyKey" IS NOT NULL');
  });

  it('refuses a same-name index that is not unique', async () => {
    // A wrong index with the right name: IF NOT EXISTS alone would
    // silently accept it, so the verification must raise.
    await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
    await pg.unsafe(
      `CREATE INDEX "${INDEX_NAME}" ON "TradingFee" USING btree ("idempotencyKey")`
    );
    try {
      await expect(runManualStep()).rejects.toThrow(/not unique/);
    } finally {
      // Restore the verified index whatever happened above.
      await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
      await runManualStep();
    }

    const state = await readIndex();
    expect(state?.indisunique).toBe(true);
    expect(state?.indisvalid).toBe(true);
  });

  it('refuses a same-name composite expression index', async () => {
    // A unique index on (idempotencyKey, lower(id)) with the right
    // name and predicate: the key-column check reads through a
    // pg_attribute join that drops the expression entry (indkey = 0),
    // so without the indnkeyatts/indexprs guard it would be reported
    // as exactly (idempotencyKey) and accepted — while duplicate
    // operation keys still insert. The verification must raise.
    await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
    await pg.unsafe(
      `CREATE UNIQUE INDEX "${INDEX_NAME}" ON "TradingFee" USING btree ("idempotencyKey", lower("id")) WHERE "idempotencyKey" IS NOT NULL`
    );
    try {
      await expect(runManualStep()).rejects.toThrow(
        /composite or expression index/
      );
    } finally {
      // Restore the verified index whatever happened above.
      await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
      await runManualStep();
    }

    const state = await readIndex();
    expect(state?.indisunique).toBe(true);
    expect(state?.indisvalid).toBe(true);
  });
});

afterAll(async () => {
  await db.delete(tradingFees).where(eq(tradingFees.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await pg.end();
});
