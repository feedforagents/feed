/**
 * Local-only preload for running the trading-balance-funding tests in a
 * sparse checkout without a full `bun install`.
 *
 * Bun's `mock.module` does not intercept the workspace-resolved `@feed/db`
 * specifier (or the service's `'../cache'` specifier, which differs from
 * the test file's `'../../cache'`) from inside the test file in this
 * environment, so the fakes are registered here first — from this file's
 * directory the `'../cache'` specifier matches the service's import
 * exactly, and the preload runs before any test import is evaluated.
 *
 * Usage (from this directory):
 *   bun test --preload ./fake-preload.ts \
 *     ./__tests__/trading-balance-funding-dispute-won.test.ts
 *
 * In CI (full install) the test file's own `mock.module` calls apply and
 * this preload is not needed.
 */
import { mock } from 'bun:test';
import { fakeFeedDbModule } from './__tests__/fake-feed-db';

mock.module('@feed/db', fakeFeedDbModule);
mock.module('../cache', () => ({
  CACHE_KEYS: { USER_BALANCE: 'user-balance', USER: 'user' },
  invalidateCache: async () => {},
}));
