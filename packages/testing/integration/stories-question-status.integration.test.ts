/** PRD §§6.1, 12 / MVP Phase 5: stories only surface questions that are still live. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const scenarios = ['statuses', 'moderation'] as const;

for (const scenario of scenarios) {
  test(`stories question status: ${scenario}`, async () => {
    // Each child owns its clock and the real module-private memory cache. No
    // shared Redis key is read, invalidated or populated by these fixtures.
    const child = Bun.spawn(
      [
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        resolve(import.meta.dir, 'helpers/stories-question-status-fixture.ts'),
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
          ALLOW_TEST_PRIVY_DID_AUTH: 'false',
          DISABLE_RATE_LIMITING: 'true',
          STEWARD_JWT_SECRET: '<MASKED_SECRET_001>',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const timeout = setTimeout(() => child.kill(), 90_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, `${scenario}\n${stdout}\n${stderr}`);
      assert.ok(
        stdout.includes(`STORIES_STATUS_FIXTURE_OK ${scenario}`),
        stdout
      );
    } finally {
      clearTimeout(timeout);
    }
  }, 120_000);
}
