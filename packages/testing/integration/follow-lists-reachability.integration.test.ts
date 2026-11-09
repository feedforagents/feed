/** Profile follow lists: paging must reach every relation exactly once. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('follow lists reachability: >100 followers and following', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      resolve(import.meta.dir, 'helpers/follow-lists-reachability-fixture.ts'),
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
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.ok(stdout.includes('FOLLOW_LISTS_FIXTURE_OK'), stdout);
  } finally {
    clearTimeout(timeout);
  }
}, 90_000);
