/** PRD §12 / MVP Phases 1/5: deletion/hiding refreshes retained post lists. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('post cache moderation, audit failure and fixture ownership in a private process', () => {
  const before = process.env.NODE_ENV;
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      resolve(
        import.meta.dir,
        'helpers/actor-posts-cache-moderation-fixture.ts'
      ),
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
        STEWARD_JWT_SECRET:
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod',
        DATABASE_URL: process.env.DATABASE_URL,
        DIRECT_DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_READ_REPLICA_URL: '',
        DATABASE_POOL_MAX: '1',
        FEED_DISABLE_REDIS: '1',
        REDIS_URL: '',
        ALLOW_TEST_PRIVY_DID_AUTH: 'false',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 25_000,
      killSignal: 'SIGKILL',
    }
  );
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  assert.equal(process.env.NODE_ENV, before);
  assert.ok(child.success, `${stdout}\n${stderr}`);
  assert.ok(stdout.includes('POST_CACHE_MODERATION_OK cases=6'), stdout);
  for (const line of stdout.split('\n')) {
    if (line.startsWith('POST_CACHE_CASE_OK ')) console.log(line);
  }
}, 30_000);
