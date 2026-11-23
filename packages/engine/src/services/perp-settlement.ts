import {
  type PerpCloseFeeRecorder,
  PerpDbAdapter,
  type PerpSettlementPort,
} from '@feed/core/markets/perps';
import type {
  AfterCommitScheduler,
  WalletPort,
} from '@feed/core/markets/shared';
import { actorState, dbWrite, sql, type Transaction, users } from '@feed/db';
import { logger } from '@feed/shared';
import { FeeService } from './fee-service';
import { createNpcWalletAdapter } from './npc-wallet-adapter';
import { createUserWalletAdapter } from './user-wallet-adapter';

export function createPerpSettlement(
  options: {
    system?: string;
    closeFeeRecorder?: (
      userId: string,
      tx: Transaction
    ) => PerpCloseFeeRecorder;
    wallet?: (
      userId: string,
      tx: Transaction,
      afterCommit: AfterCommitScheduler
    ) => WalletPort | Promise<WalletPort>;
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
          (await options.wallet?.(userId, tx, afterCommit)) ??
          createUserWalletAdapter(tx, afterCommit);
        return operation(
          new PerpDbAdapter(tx),
          wallet,
          options.closeFeeRecorder?.(userId, tx)
        );
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

export function createPerpLiquidationSettlement(): PerpSettlementPort {
  return createPerpSettlement({
    system: 'perp_price_sweep',
    wallet: async (userId, tx, afterCommit) => {
      // ActorState backs NPC trades even when the shadow user row is missing
      // or predates isActor. A known NPC with no wallet must fail on credit.
      const [owner] = await tx.execute<{ isNpc: boolean }>(sql`
        SELECT (
          EXISTS (SELECT 1 FROM ${actorState} WHERE ${actorState.id} = ${userId})
          OR EXISTS (
            SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} AND ${users.isActor}
          )
        ) AS "isNpc"
      `);
      return owner?.isNpc
        ? createNpcWalletAdapter(userId, tx)
        : createUserWalletAdapter(tx, afterCommit);
    },
  });
}

export function createNpcPerpSettlement(): PerpSettlementPort {
  return createPerpSettlement({
    system: 'npc_perp_trade',
    wallet: createNpcWalletAdapter,
    closeFeeRecorder: (userId, tx) => async (positionId, ticker, feeAmount) => {
      await FeeService.recordTradingFee(
        userId,
        'perp_close',
        feeAmount,
        positionId,
        ticker,
        tx
      );
    },
  });
}
