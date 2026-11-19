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
import { generateSnowflakeId, type JsonValue, logger } from '@feed/shared';
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
   */
  idempotencyKey?: string;
};

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

    // A resend of a keyed trade replays the first execution's result.
    // The lookup runs after the advisory lock, so a concurrent resend on
    // the same market waits here and then sees the committed row instead
    // of executing twice. (A key reused across different markets is a
    // client error and is not serialized — the key must be unique per
    // trade request.)
    if (idempotencyKey) {
      const [existing] = await tx
        .select({ result: predictionTradeIdempotency.result })
        .from(predictionTradeIdempotency)
        .where(
          and(
            eq(predictionTradeIdempotency.userId, userId),
            eq(predictionTradeIdempotency.idempotencyKey, idempotencyKey)
          )
        );
      if (existing) {
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
      await tx.insert(predictionTradeIdempotency).values({
        id: await generateSnowflakeId(),
        userId,
        idempotencyKey,
        marketId,
        result: result as unknown as JsonValue,
      });
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
