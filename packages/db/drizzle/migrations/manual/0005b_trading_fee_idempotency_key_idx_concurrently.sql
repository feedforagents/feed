-- Manual migration step for 0005 (NOT run by `drizzle-kit migrate`).
--
-- Creates the partial unique index backing FeeService's idempotent
-- replay. Run OUTSIDE a transaction, BEFORE deploying the app that
-- writes idempotencyKey — CREATE INDEX CONCURRENTLY cannot run inside
-- a transaction block, and Drizzle runs every journaled migration
-- inside one transaction, so this step must never be added to the
-- journal (AGENTS.md, "Production database (scale and locks)" / DDL).
-- Never run this file with `psql -1` (single transaction): the build
-- itself must stay outside any transaction.
--
-- Rollout order (the migrated schema and this verified index are
-- prerequisites for every new application instance — there is no
-- old-schema compatibility. FeeService's INSERT names idempotencyKey
-- on every call — NULL for unkeyed calls — and both outbox adapters
-- write their idempotencyKey field the same way, so fee writes fail
-- against a schema without the 0005 columns; this unique index is
-- the replay backstop described in fee-service.ts):
--   1. `bun run db:migrate`   (0005: both idempotencyKey columns)
--   2. psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>
--      (builds the index, then verifies it below and aborts on any
--      failed check — do not deploy if this step fails)
--   3. Deploy the app.
--
-- Verification (this file, after the build): pg_indexes.indexdef
-- cannot prove the build used CONCURRENTLY — PostgreSQL reconstructs
-- the definition without that creation mode — and IF NOT EXISTS
-- accepts an existing index of the same name without proving it is
-- equivalent. So the check below reads pg_index directly: the index
-- must exist on "TradingFee", cover exactly ("idempotencyKey"), be
-- unique, valid AND ready, carry the partial predicate
-- ("idempotencyKey" IS NOT NULL), and have exactly one key attribute
-- with no expression entries. The last check matters because the
-- key-column read joins pg_attribute, which drops expression entries
-- (indkey = 0): without it, a same-name unique index on
-- (idempotencyKey, lower(id)) would be reported as exactly
-- (idempotencyKey) even though it permits duplicate operation keys.
-- Any failed check raises, and the operator must fix the index (see
-- below) before deploying.
--
-- Interrupted build: if the build is cancelled or crashes midway it
-- leaves an INVALID index behind. A re-run of this file does NOT fix
-- that — IF NOT EXISTS sees the name and skips — so the verification
-- below fails loudly instead. Recover with:
--   DROP INDEX CONCURRENTLY IF EXISTS "TradingFee_idempotencyKey_idx";
-- then re-run this file. CONCURRENTLY takes only a SHARE UPDATE
-- EXCLUSIVE lock, so concurrent fee inserts/updates are not blocked;
-- on a populated table the build scans the table instead of locking
-- it.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS
-- "TradingFee_idempotencyKey_idx".
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "TradingFee_idempotencyKey_idx" ON "TradingFee" USING btree ("idempotencyKey") WHERE "TradingFee"."idempotencyKey" IS NOT NULL;

-- Verify the index before deployment. Raises on the first failed
-- check (psql -v ON_ERROR_STOP=1 aborts the rollout). Reads
-- pg_index directly: indexdef cannot show whether CONCURRENTLY was
-- used, and IF NOT EXISTS cannot show the index is equivalent.
DO $$
DECLARE
  idx record;
  key_cols text[];
BEGIN
  SELECT ix.* INTO idx
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  WHERE i.relname = 'TradingFee_idempotencyKey_idx'
    AND t.relname = 'TradingFee';

  IF idx IS NULL THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is missing on "TradingFee": run the 0005b build step before deploying';
  END IF;

  IF NOT idx.indisunique THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is not unique: drop it and re-run the 0005b build step before deploying';
  END IF;

  IF NOT idx.indisvalid THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is INVALID (interrupted build): DROP INDEX CONCURRENTLY IF EXISTS "TradingFee_idempotencyKey_idx" and re-run the 0005b build step before deploying';
  END IF;

  IF NOT idx.indisready THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is not ready: re-run the 0005b build step before deploying';
  END IF;

  -- Reject composite or expression indexes before the column check
  -- below: the pg_attribute join drops expression entries (indkey =
  -- 0), so a same-name unique index on (idempotencyKey, lower(id))
  -- would otherwise be reported as exactly (idempotencyKey) while
  -- still permitting duplicate operation keys.
  IF idx.indnkeyatts <> 1 OR idx.indexprs IS NOT NULL THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is a composite or expression index (indnkeyatts=%, has expressions=%): drop it and re-run the 0005b build step before deploying', idx.indnkeyatts, idx.indexprs IS NOT NULL;
  END IF;

  SELECT array_agg(a.attname ORDER BY k.ord)
    INTO key_cols
  FROM unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a
    ON a.attrelid = idx.indrelid AND a.attnum = k.attnum;

  IF key_cols IS DISTINCT FROM ARRAY['idempotencyKey'] THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx covers the wrong key columns (%): drop it and re-run the 0005b build step before deploying', key_cols;
  END IF;

  IF pg_get_expr(idx.indpred, idx.indrelid) IS DISTINCT FROM '("idempotencyKey" IS NOT NULL)' THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx has the wrong predicate (%): drop it and re-run the 0005b build step before deploying', pg_get_expr(idx.indpred, idx.indrelid);
  END IF;

  RAISE NOTICE 'TradingFee_idempotencyKey_idx verified: unique, valid, ready, key (idempotencyKey), predicate ("idempotencyKey" IS NOT NULL)';
END $$;
