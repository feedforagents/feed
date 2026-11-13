/**
 * User Wallet Adapter
 *
 * Wraps WalletService to implement the core markets WalletPort for real
 * users and agents. When `dbClient` is supplied (e.g. an `asUser`
 * transaction), every wallet mutation — including PnL recording — enlists in
 * that transaction instead of opening a second one against the same locked
 * user row.
 */
import type {
  AfterCommitScheduler,
  WalletPort,
} from '@feed/core/markets/shared';
import type { DrizzleClient, Transaction } from '@feed/db';
import { WalletService } from './wallet-service';

export function createUserWalletAdapter(
  dbClient?: Transaction | DrizzleClient,
  afterCommit?: AfterCommitScheduler
): WalletPort {
  return {
    debit: ({ userId, amount, reason, description, relatedId }) =>
      WalletService.debit(
        userId,
        amount,
        reason,
        description ?? '',
        relatedId,
        dbClient,
        afterCommit
      ),
    credit: ({ userId, amount, reason, description, relatedId }) =>
      WalletService.credit(
        userId,
        amount,
        reason,
        description ?? '',
        relatedId,
        dbClient,
        afterCommit
      ),
    recordPnL: async ({ userId, pnl, reason, relatedId }) => {
      await WalletService.recordPnL(
        userId,
        pnl,
        reason,
        relatedId,
        dbClient,
        afterCommit
      );
    },
    getBalance: (userId: string) => WalletService.getBalance(userId, dbClient),
  };
}
