/**
 * Cache Module Exports
 *
 * @description Exports cache service and cached database service
 */

import { WalletService } from '@feed/engine';

import { CACHE_KEYS, invalidateCache } from './cache-service';

// WalletService.setCacheInvalidationCallback has no other installer anywhere in
// the repo, so every debit/credit/recordPnL call was a no-op here and the
// cached balance row (`user:balance:<id>`, 30s TTL) stayed stale through trades
// and settlements. This barrel is loaded by `@feed/api`, which every route and
// integration test imports. Mirrors the trade-cache wiring in
// apps/web/instrumentation.ts.
WalletService.setCacheInvalidationCallback(async (userId: string) => {
  await invalidateCache(userId, { namespace: CACHE_KEYS.USER_BALANCE });
});

export * from './cache-service';
export * from './cached-database-service';
export * from './markets-api-cache';
