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
-- unique, valid, ready AND live, use btree, carry the partial predicate
-- ("idempotencyKey" IS NOT NULL), and have exactly one key attribute
-- with no expression or included-column entries. The last check matters because the
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
--   DROP INDEX CONCURRENTLY IF EXISTS public."TradingFee_idempotencyKey_idx";
-- then re-run this file. CONCURRENTLY takes only a SHARE UPDATE
-- EXCLUSIVE lock, so concurrent fee inserts/updates are not blocked;
-- the build still takes locks and may wait for other transactions or DDL.
-- Use an approved bounded lock/statement timeout and inspect failures.
--
-- Do not drop this backstop while keyed application writers/drainers run.
-- A code rollback needs an explicit outbox/replay reconciliation plan.
-- Operator-only recovery, after verifying the exact object and dependencies:
-- DROP INDEX CONCURRENTLY IF EXISTS public."TradingFee_idempotencyKey_idx".
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "TradingFee_idempotencyKey_idx" ON public."TradingFee" USING btree ("idempotencyKey") WHERE "TradingFee"."idempotencyKey" IS NOT NULL;

-- Verify the index before deployment. Raises on the first failed
-- check (psql -v ON_ERROR_STOP=1 aborts the rollout). Reads
-- pg_index directly: indexdef cannot show whether CONCURRENTLY was
-- used, and IF NOT EXISTS cannot show the index is equivalent.
DO $$
DECLARE
  idx record;
  key_cols text[];
BEGIN
  SELECT ix.*, i.relkind, am.amname AS method INTO idx
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid = i.relam
  WHERE ix.indexrelid = pg_catalog.to_regclass('public."TradingFee_idempotencyKey_idx"')
    AND ix.indrelid = pg_catalog.to_regclass('public."TradingFee"');

  IF idx IS NULL THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is missing on the exact public."TradingFee" table (or targets another table): run the 0005b build step before deploying';
  END IF;

  IF idx.relkind <> 'i' OR idx.method <> 'btree' THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is not a plain btree index on public."TradingFee": inspect the exact object before recovery';
  END IF;

  IF NOT idx.indislive THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is being removed: inspect the exact object before recovery';
  END IF;

  IF NOT idx.indisunique THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is not unique: drop it and re-run the 0005b build step before deploying';
  END IF;

  IF NOT idx.indisvalid THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx is INVALID (interrupted build): DROP INDEX CONCURRENTLY IF EXISTS public."TradingFee_idempotencyKey_idx" and re-run the 0005b build step before deploying';
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

  IF idx.indnatts <> 1 THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx has included columns: inspect the exact object before recovery';
  END IF;

  SELECT array_agg(a.attname ORDER BY k.ord)
    INTO key_cols
  FROM unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = idx.indrelid AND a.attnum = k.attnum;

  IF key_cols IS DISTINCT FROM ARRAY['idempotencyKey'] THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx covers the wrong key columns (%): drop it and re-run the 0005b build step before deploying', key_cols;
  END IF;

  IF pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) IS DISTINCT FROM '("idempotencyKey" IS NOT NULL)' THEN
    RAISE EXCEPTION 'TradingFee_idempotencyKey_idx has the wrong predicate (%): drop it and re-run the 0005b build step before deploying', pg_catalog.pg_get_expr(idx.indpred, idx.indrelid);
  END IF;

  RAISE NOTICE 'TradingFee_idempotencyKey_idx verified: public target, btree, unique, valid, ready, live, key (idempotencyKey), predicate ("idempotencyKey" IS NOT NULL)';
END $$;
