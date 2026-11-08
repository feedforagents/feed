/**
 * Create the unique index on TradingFee.idempotencyKey concurrently.
 *
 * Why this is a separate script instead of a Drizzle migration: TradingFee
 * is a populated table, and a plain CREATE UNIQUE INDEX would block writes
 * while it builds. CREATE INDEX CONCURRENTLY avoids the write lock, but it
 * cannot run inside a transaction block — and Drizzle's migrator wraps
 * every migration file (including 0005) in a single transaction, so putting
 * the statement there fails. Migration 0005 therefore only adds the
 * idempotencyKey columns (plus the unique index on the newly created,
 * empty TradingFeeOutbox table, which is safe inside the transaction).
 *
 * This script runs the concurrent build outside any transaction, so it
 * must run AFTER `bun run db:migrate` has applied 0005 (the column must
 * exist first). It is idempotent: re-running it after the index exists is
 * a no-op. The index definition matches the uniqueIndex declared in
 * packages/db/src/schema/trading.ts and recorded in the 0005 snapshot, so
 * `drizzle-kit generate`/`check` stay in sync.
 *
 * A failed concurrent build can leave behind an INVALID index with the
 * same name; IF NOT EXISTS would then skip the rebuild, so this script
 * verifies pg_index.indisvalid afterwards and fails loudly with the
 * drop-and-retry instruction instead of silently leaving an invalid index.
 *
 * Usage: DATABASE_URL=postgresql://<user>:<password>@localhost:5432/feed bun run db:apply-trading-fee-idempotency-index
 *        (from the repo root; or `bun scripts/apply-trading-fee-idempotency-index.ts` from packages/db)
 *
 * Options:
 *   --dry-run    Report what would run without creating the index
 */

import postgres from 'postgres';

const INDEX_NAME = 'TradingFee_idempotencyKey_idx';
/** Quoted name as regclass input for to_regclass(). */
const INDEX_REGCLASS = `"${INDEX_NAME}"`;
const CREATE_INDEX_SQL = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX_NAME}" ON "TradingFee" USING btree ("idempotencyKey")`;

export async function applyTradingFeeIdempotencyIndex(
  sql: postgres.Sql,
  options: { dryRun: boolean }
): Promise<{ created: boolean; alreadyExists: boolean }> {
  // Pre-check: the column must exist (migration 0005 applied). A missing
  // column would otherwise surface as a bare Postgres error.
  const [column] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'TradingFee' AND column_name = 'idempotencyKey'
    ) AS exists
  `;
  if (!column?.exists) {
    throw new Error(
      'TradingFee.idempotencyKey column is missing — run `bun run db:migrate` (migration 0005) first.'
    );
  }

  const [before] = await sql<{ valid: boolean | null }[]>`
    SELECT indisvalid AS valid FROM pg_index
    WHERE indexrelid = to_regclass(${INDEX_REGCLASS})
  `;
  if (before) {
    if (before.valid === false) {
      throw new Error(
        `Index "${INDEX_NAME}" exists but is INVALID (a previous concurrent build failed). ` +
          `Drop it with DROP INDEX "${INDEX_NAME}"; then re-run this script.`
      );
    }
    return { created: false, alreadyExists: true };
  }

  if (options.dryRun) {
    return { created: false, alreadyExists: false };
  }

  // Single statement, no explicit transaction: postgres.js runs it outside
  // any transaction block, which is what CONCURRENTLY requires.
  await sql.unsafe(CREATE_INDEX_SQL);

  const [after] = await sql<{ valid: boolean | null }[]>`
    SELECT indisvalid AS valid FROM pg_index
    WHERE indexrelid = to_regclass(${INDEX_REGCLASS})
  `;
  if (!after || after.valid !== true) {
    throw new Error(
      `Index "${INDEX_NAME}" was not created valid. ` +
        `If a previous concurrent build left it INVALID, drop it with DROP INDEX "${INDEX_NAME}" and re-run this script.`
    );
  }
  return { created: true, alreadyExists: false };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  const sql = postgres(databaseUrl);
  try {
    console.log(`Index: ${INDEX_NAME}`);
    console.log(`Statement: ${CREATE_INDEX_SQL}`);
    const result = await applyTradingFeeIdempotencyIndex(sql, { dryRun });
    if (result.alreadyExists) {
      console.log('Index already exists and is valid — nothing to do.');
    } else if (dryRun) {
      console.log('Would create the index concurrently.');
    } else {
      console.log('Created valid unique index concurrently.');
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error('Error:', error);
    process.exitCode = 1;
  });
}
