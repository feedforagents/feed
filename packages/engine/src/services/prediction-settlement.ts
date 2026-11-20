import {
  PredictionDbAdapter,
  PredictionMarketService,
  type PredictionServiceDeps,
} from '@feed/core/markets/prediction';
import type {
  AfterCommitScheduler,
  FeeProcessor,
  WalletPort,
} from '@feed/core/markets/shared';
import {
  and,
  dbWrite,
  eq,
  markets,
  predictionTradeIdempotency,
  sql,
  type Transaction,
} from '@feed/db';
import {
  ConflictError,
  generateSnowflakeId,
  type JsonValue,
  logger,
} from '@feed/shared';
import { createNpcWalletAdapter } from './npc-wallet-adapter';
import { StaticDataRegistry } from './static-data-registry';
import { createUserWalletAdapter } from './user-wallet-adapter';

type SettlementContext = { userId: string } | { system: string };

export type PredictionSettlementOptions = Omit<
  PredictionServiceDeps,
  'db' | 'wallet' | 'afterCommit' | 'feeProcessor'
> & {
  feeProcessor?: (tx: Transaction) => FeeProcessor;
  wallet?: (tx: Transaction, afterCommit: AfterCommitScheduler) => WalletPort;
  /**
   * Client-supplied idempotency key for one trade request (e.g. the web
   * buy/sell route's `Idempotency-Key` header). When set, a resend with
   * the same key replays the stored first-execution result instead of
   * executing the trade again. Unset for callers that do not carry a key
   * (older surfaces, system flows); those are not deduplicated.
   * Same shape as the fee legs' operationId (migration 0005), extended
   * to the trade body itself.
   *
   * A replay only matches the identical request: same market, same
   * operation and same fingerprint (see below). Reusing the key for a
   * different request is a client error (409), not a replay.
   */
  idempotencyKey?: string;
  /**
   * 'buy' | 'sell' — stored with the key row and compared on replay.
   * Required whenever `idempotencyKey` is set by a route.
   */
  idempotencyOperation?: 'buy' | 'sell';
  /**
   * Request fingerprint, e.g. buy `{side, amount}` or sell
   * `{shares, positionId}` serialized. Stored with the key row and
   * compared on replay; a different body under the same key is a 409.
   */
  idempotencyFingerprint?: string;
};

/** Postgres unique_violation (23505), on the error itself or its cause. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code === '23505';
}

/** Resolve mixed player/NPC holdings back to the wallet that funds trades. */
export function createPredictionSettlementWallet(
  tx: Transaction,
  afterCommit: AfterCommitScheduler
): WalletPort {
  const userWallet = createUserWalletAdapter(tx, afterCommit);
  const walletFor = (userId: string) =>
    StaticDataRegistry.getActor(userId)
      ? createNpcWalletAdapter(userId, tx)
      : userWallet;
  return {
    debit: (payment) => walletFor(payment.userId).debit(payment),
    credit: (payment) => walletFor(payment.userId).credit(payment),
    recordPnL: (entry) => walletFor(entry.userId).recordPnL(entry),
    getBalance: (userId) => walletFor(userId).getBalance(userId),
  };
}

/** Keep a market, its holdings, and its wallet mutations in one commit. */
export async function withPredictionSettlement<T>(
  marketId: string,
  context: SettlementContext,
  operation: (service: PredictionMarketService, tx: Transaction) => Promise<T>,
  options: PredictionSettlementOptions
): Promise<T> {
  const {
    wallet: walletFactory,
    feeProcessor: feeProcessorFactory,
    idempotencyKey,
    idempotencyOperation,
    idempotencyFingerprint,
    ...serviceOptions
  } = options;
  const committed = await dbWrite.transaction(async (tx) => {
    const effects: Array<() => Promise<void>> = [];
    const afterCommit: AfterCommitScheduler = (effect) => effects.push(effect);
    const userId = 'userId' in context ? context.userId : 'system';
    await tx.execute(
      sql`SELECT set_config('app.current_user_id', ${userId}, true)`
    );
    // The advisory lock also covers the first trade before a market row exists.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'prediction-settlement:' + marketId}))`
    );
    await tx
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, marketId))
      .for('update');

    // A resend of a keyed trade replays the first execution's result —
    // but only for the identical request. The key is bound to one
    // market, one operation and one request body: reusing it for a
    // different market, a sell instead of a buy, or a different
    // side/amount is a client error (409), not a replay. A replayed
    // first result for a request that was never made would tell the
    // client a trade it did not make had succeeded.
    // The lookup runs after the advisory lock, so a concurrent resend on
    // the same market waits here and then sees the committed row instead
    // of executing twice. (A key reused across different markets is a
    // client error and is not serialized — the unique index is the
    // backstop and its violation is mapped to 409 below.)
    if (idempotencyKey) {
      const [existing] = await tx
        .select({
          marketId: predictionTradeIdempotency.marketId,
          operation: predictionTradeIdempotency.operation,
          fingerprint: predictionTradeIdempotency.fingerprint,
          result: predictionTradeIdempotency.result,
        })
        .from(predictionTradeIdempotency)
        .where(
          and(
            eq(predictionTradeIdempotency.userId, userId),
            eq(predictionTradeIdempotency.idempotencyKey, idempotencyKey)
          )
        );
      if (existing) {
        if (
          existing.marketId !== marketId ||
          existing.operation !== (idempotencyOperation ?? '') ||
          existing.fingerprint !== (idempotencyFingerprint ?? '')
        ) {
          throw new ConflictError(
            'Idempotency-Key was already used for a different prediction trade request'
          );
        }
        return { result: existing.result as unknown as T, effects };
      }
    }

    const service = new PredictionMarketService({
      ...serviceOptions,
      db: new PredictionDbAdapter(tx),
      wallet:
        walletFactory?.(tx, afterCommit) ??
        createPredictionSettlementWallet(tx, afterCommit),
      afterCommit,
      feeProcessor: feeProcessorFactory?.(tx),
    });
    const result = await operation(service, tx);
    if (idempotencyKey) {
      try {
        await tx.insert(predictionTradeIdempotency).values({
          id: await generateSnowflakeId(),
          userId,
          idempotencyKey,
          marketId,
          operation: idempotencyOperation ?? '',
          fingerprint: idempotencyFingerprint ?? '',
          result: result as unknown as JsonValue,
        });
      } catch (error) {
        // A concurrent same-key trade on a different market is not
        // serialized by the per-market advisory lock, so both execute
        // and the loser hits the (userId, idempotencyKey) unique index.
        // The loser's trade rolls back with this transaction; report a
        // 409 instead of a raw 500. Log without SQL parameters.
        if (isUniqueViolation(error)) {
          logger.warn(
            'Prediction idempotency key collision',
            { marketId, operation: idempotencyOperation ?? '' },
            'PredictionSettlement'
          );
          throw new ConflictError(
            'Idempotency-Key was already used for a different prediction trade request'
          );
        }
        throw error;
      }
    }
    return { result, effects };
  });

  for (const effect of committed.effects) {
    try {
      await effect();
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'Error';
      // The trade has committed. A notification/cache outage must not invite
      // another attempt at a successful non-idempotent financial operation.
      logger.error(
        'Prediction post-commit effect failed',
        {
          marketId,
          context: 'userId' in context ? 'user' : context.system,
          errorName,
        },
        'PredictionSettlement'
      );
    }
  }
  return committed.result;
}
