/** Stories rail: cursor pagination must reach every story the rail lists. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('stories rail cursor traversal delivers every story exactly once', async () => {
  // Fresh process: the stories snapshot cache is module-private, and the
  // fixture owns its seeded rows in an isolated test database.
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, 'helpers/stories-rail-cursor-fixture.ts'),
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
        DISABLE_RATE_LIMITING: 'true',
        FEED_DISABLE_REDIS: '1',
        REDIS_URL: '',
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
    // Check the marker first: a child that printed OK but never exited is
    // reported as a clean assertion with stdout, not a 60 s wall.
    assert.ok(stdout.includes('STORIES_RAIL_FIXTURE_OK rail'), stdout);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timeout);
  }
}, 60_000);
