/** Narrative reads honor shared viewer moderation (PRD §§8.1 and 12). */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runIsolatedSubMarketCases } from './helpers/sub-market-isolation';

const scenarios = ['viewer', 'repost', 'mixed'] as const;
const caseName = (scenario: (typeof scenarios)[number]) =>
  `narrative viewer moderation: ${scenario}`;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks narrative moderation in disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'narrative-viewer-moderation',
      file: 'packages/testing/integration/narrative-viewer-moderation.integration.test.ts',
      cases: scenarios.map(caseName),
    });
  }, 300_000);
} else {
  for (const scenario of scenarios) {
    test(caseName(scenario), async () => {
      // Each child has its own clock and cache, and must verify the database
      // lease before touching any fixture rows.
      const child = Bun.spawn(
        [
          process.execPath,
          '--config=/dev/null',
          '--no-env-file',
          resolve(
            import.meta.dir,
            'helpers/narrative-viewer-moderation-fixture.ts'
          ),
          scenario,
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
            FEED_SUB_MARKET_CHILD: process.env.FEED_SUB_MARKET_CHILD,
            FEED_SUB_MARKET_LEASE_FILE: process.env.FEED_SUB_MARKET_LEASE_FILE,
            FEED_DISABLE_REDIS: '1',
            REDIS_URL: '',
            ALLOW_TEST_PRIVY_DID_AUTH: 'false',
            STEWARD_JWT_SECRET: randomUUID(),
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
          stdout.includes(`NARRATIVE_MODERATION_OK ${scenario}`),
          stdout
        );
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
