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
import { dbWrite, eq, markets, sql, type Transaction } from '@feed/db';
import { logger } from '@feed/shared';
import { createUserWalletAdapter } from './user-wallet-adapter';

type SettlementContext = { userId: string } | { system: string };

export type PredictionSettlementOptions = Omit<
  PredictionServiceDeps,
  'db' | 'wallet' | 'afterCommit' | 'feeProcessor'
> & {
  feeProcessor?: (tx: Transaction) => FeeProcessor;
  wallet?: (tx: Transaction, afterCommit: AfterCommitScheduler) => WalletPort;
};

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

    const service = new PredictionMarketService({
      ...serviceOptions,
      db: new PredictionDbAdapter(tx),
      wallet:
        walletFactory?.(tx, afterCommit) ??
        createUserWalletAdapter(tx, afterCommit),
      afterCommit,
      feeProcessor: feeProcessorFactory?.(tx),
    });
    const result = await operation(service, tx);
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
