import {
  PerpDbAdapter,
  type PerpSettlementPort,
} from '@feed/core/markets/perps';
import type {
  AfterCommitScheduler,
  WalletPort,
} from '@feed/core/markets/shared';
import { dbWrite, sql, type Transaction } from '@feed/db';
import { logger } from '@feed/shared';
import { createUserWalletAdapter } from './user-wallet-adapter';

export function createPerpSettlement(
  options: {
    system?: string;
    wallet?: (
      userId: string,
      tx: Transaction,
      afterCommit: AfterCommitScheduler
    ) => WalletPort;
  } = {}
): PerpSettlementPort {
  return {
    async run(userId, operation) {
      const effects: Array<() => Promise<void>> = [];
      const afterCommit: AfterCommitScheduler = (effect) =>
        effects.push(effect);
      const result = await dbWrite.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${options.system ? 'system' : userId}, true)`
        );
        // Every exposure-increasing operation for this owner shares this lock,
        // even when the orders target different tickers or have no position yet.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'perp-exposure:' + userId}))`
        );
        const wallet =
          options.wallet?.(userId, tx, afterCommit) ??
          createUserWalletAdapter(tx, afterCommit);
        return operation(new PerpDbAdapter(tx), wallet);
      });
      for (const effect of effects) {
        try {
          await effect();
        } catch (error: unknown) {
          const errorName = error instanceof Error ? error.name : 'Error';
          logger.error(
            'Perp post-commit cache invalidation failed',
            { errorName },
            'PerpSettlement'
          );
        }
      }
      return result;
    },
  };
}
