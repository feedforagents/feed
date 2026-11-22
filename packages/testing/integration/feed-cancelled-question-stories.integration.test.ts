/** PRD §§6.1, 12 / MVP Phase 5: voided (cancelled) questions leave story surfaces. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const scenarios = ['for-you', 'narrative', 'spill'] as const;

for (const scenario of scenarios) {
  test(`cancelled question stories: ${scenario}`, async () => {
    // Each child owns its clock and the module-private memory caches, so the
    // real route handlers compute fresh results from the seeded rows.
    const child = Bun.spawn(
      [
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        resolve(
          import.meta.dir,
          'helpers/feed-cancelled-question-stories-fixture.ts'
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
          DIRECT_DATABASE_URL: process.env.DATABASE_URL,
          DATABASE_READ_REPLICA_URL: '',
          DATABASE_POOL_MAX: '5',
          FEED_DISABLE_REDIS: '1',
          REDIS_URL: '',
          DISABLE_RATE_LIMITING: 'true',
          ALLOW_TEST_PRIVY_DID_AUTH: 'false',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const timeout = setTimeout(() => child.kill(), 55_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, `${scenario}\n${stdout}\n${stderr}`);
      assert.ok(stdout.includes(`F159_FIXTURE_OK ${scenario}`), stdout);
    } finally {
      clearTimeout(timeout);
    }
  }, 60_000);
}
