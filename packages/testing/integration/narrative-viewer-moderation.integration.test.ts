/** PRD §8.1 (same business logic/moderation as the website) and §12
 * (block/mute kept): the narrative story surface applies the viewer's
 * block/mute policy like the stories and For You surfaces do. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const scenarios = ['viewer', 'repost', 'mixed'] as const;

for (const scenario of scenarios) {
  test(`narrative viewer moderation: ${scenario}`, async () => {
    // Each child owns its clock and the real module-private memory cache. No
    // shared Redis key is read, invalidated or populated by these fixtures.
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
          DIRECT_DATABASE_URL: process.env.DATABASE_URL,
          DATABASE_READ_REPLICA_URL: '',
          DATABASE_POOL_MAX: '5',
          FEED_DISABLE_REDIS: '1',
          REDIS_URL: '',
          ALLOW_TEST_PRIVY_DID_AUTH: 'false',
          DISABLE_RATE_LIMITING: 'true',
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
      assert.ok(stdout.includes(`NARRATIVE_MODERATION_OK ${scenario}`), stdout);
    } finally {
      clearTimeout(timeout);
    }
  }, 60_000);
}
