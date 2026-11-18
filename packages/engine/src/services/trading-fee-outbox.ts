/**
 * Durable queue for perp (and future) trading fees when inline processing fails after retries.
 *
 * Each row is claimed (DELETE … RETURNING) at the start of the same Postgres
 * transaction that runs `FeeService.processTradingFee`, so concurrent drains
 * cannot both charge a row and a crash after charging cannot leave a stale
 * row that would double-charge on retry.
 *
 * Idempotency: every fee leg carries one `operationId`, generated once per
 * invocation by the perp fee helper and reused across its retries. The key
 * is carried into the outbox when the retries exhaust, and the drain replays
 * under it, so an ambiguous commit (fee committed, caller only saw an
 * error) never charges twice: `FeeService.processTradingFee` returns the
 * already-recorded fee when the key exists.
 */

import type { TradingFeeOutboxPort } from '@feed/core/markets/shared';
import {
  db,
  dbWrite,
  eq,
  type Transaction,
  tradingFeeOutbox,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { asc } from 'drizzle-orm';
import { type FeeType, isValidFeeType } from '../config/fees';
import { FeeService } from './fee-service';

const DRAIN_BATCH_SIZE = 50;

export async function enqueueFailedTradingFee(params: {
  userId: string;
  amount: number;
  type: string;
  relatedId: string;
  positionId: string;
  operationId?: string;
  lastError?: string;
}): Promise<void> {
  const id = await generateSnowflakeId();
  await db.insert(tradingFeeOutbox).values({
    id,
    userId: params.userId,
    tradeType: params.type,
    tradeAmount: String(params.amount),
    tradeId: params.positionId,
    marketId: params.relatedId,
    idempotencyKey: params.operationId ?? null,
    lastError: params.lastError ?? null,
  });
}

export function createTradingFeeOutboxAdapter(): TradingFeeOutboxPort {
  return {
    enqueue: (p) => enqueueFailedTradingFee(p),
  };
}

export async function drainTradingFeeOutboxBatch(): Promise<{
  examined: number;
  processed: number;
  failed: number;
}> {
  // Drain must read from primary to avoid replica lag re-processing already-deleted rows.
  const rows = await dbWrite
    .select()
    .from(tradingFeeOutbox)
    .orderBy(asc(tradingFeeOutbox.createdAt))
    .limit(DRAIN_BATCH_SIZE);

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    // Validate tradeType before processing to catch invalid data early
    if (!isValidFeeType(row.tradeType)) {
      failed += 1;
      logger.error(
        'Invalid tradeType in outbox — skipping row',
        {
          outboxId: row.id,
          userId: row.userId,
          tradeType: row.tradeType,
        },
        'TradingFeeOutbox'
      );
      continue;
    }

    try {
      const claimed = await withTransaction(async (tx: Transaction) => {
        // Claim the row first: the DELETE row-locks it, so a concurrent drain
        // blocks here and then finds nothing to process once we commit (or
        // gets the row back if we roll back). Never charge an unclaimed row.
        const [claimedRow] = await tx
          .delete(tradingFeeOutbox)
          .where(eq(tradingFeeOutbox.id, row.id))
          .returning({ id: tradingFeeOutbox.id });
        if (!claimedRow) return false;

        // Replay under the row's stored key when it has one: the fee
        // may already have committed inline while every retry observed
        // an error, so an unkeyed drain would insert a second row and
        // double-count totals and the fund diversion. Rows enqueued
        // without a key (older callers) drain unkeyed, as before.
        await FeeService.processTradingFee(
          row.userId,
          row.tradeType as FeeType,
          Number(row.tradeAmount),
          row.tradeId ?? undefined,
          row.marketId ?? undefined,
          tx,
          row.idempotencyKey ?? undefined
        );
        return true;
      });
      if (claimed) processed += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        'Trading fee outbox row failed (will retry on next drain)',
        {
          outboxId: row.id,
          userId: row.userId,
          tradeType: row.tradeType,
          error: error instanceof Error ? error.message : String(error),
        },
        'TradingFeeOutbox'
      );
    }
  }

  return { examined: rows.length, processed, failed };
}
