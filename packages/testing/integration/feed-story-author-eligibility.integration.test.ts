/** PRD §§6.1, 12 / MVP Phase 5: story surfaces retain existing feed author eligibility. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const scenarios = ['recent', 'backfill', 'discovery'] as const;
const caseName = (scenario: (typeof scenarios)[number]) =>
  `for-you/narrative author eligibility: ${scenario}`;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks story author eligibility on a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'feed-story-author-eligibility',
      file: 'packages/testing/integration/feed-story-author-eligibility.integration.test.ts',
      cases: scenarios.map(caseName),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  for (const [index, scenario] of scenarios.entries()) {
    test(caseName(scenario), async () => {
      // Fresh process memory isolates the cache. The offset separates windows
      // within the same database lease without deleting any fixture rows.
      const child = Bun.spawn(
        [
          process.execPath,
          '--config=/dev/null',
          '--no-env-file',
          resolve(
            import.meta.dir,
            'helpers/feed-story-author-eligibility-fixture.ts'
          ),
          scenario,
          String(index),
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            TZ: 'UTC',
            NODE_ENV: 'test',
            BUN_ENV: 'test',
            CI: 'false',
            DATABASE_URL: process.env.DATABASE_URL,
            DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
            DATABASE_READ_REPLICA_URL: '',
            DATABASE_POOL_MAX: '5',
            FEED_DISABLE_REDIS: '1',
            REDIS_URL: '',
            ALLOW_TEST_PRIVY_DID_AUTH: 'false',
            FEED_SUB_MARKET_CHILD: process.env.FEED_SUB_MARKET_CHILD,
            FEED_SUB_MARKET_LEASE_FILE: process.env.FEED_SUB_MARKET_LEASE_FILE,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const timeout = setTimeout(() => child.kill(), 25_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(code, 0, `${scenario}\n${stdout}\n${stderr}`);
        assert.ok(
          stdout.includes(`FEED_STORY_ELIGIBILITY_OK ${scenario}`),
          stdout
        );
      } finally {
        clearTimeout(timeout);
      }
    }, 30_000);
  }
}
