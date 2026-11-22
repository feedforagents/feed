/**
 * PRD 8.1 / 12, MVP Phases 1 and 3: a post created or deleted through MCP
 * (create_post, delete_post) or A2A (social.create_post, social.delete_post)
 * must refresh the Recent, Following and author post-list caches, the same
 * way the website POST /api/posts and DELETE /api/posts/[id] routes do.
 * Before the fix the agent paths wrote the row and left every warmed list
 * serving the old page until its TTL (45 s for the feeds, 180 s for the
 * author profile).
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('MCP and A2A post writes refresh cached post lists in a private process', () => {
  const before = process.env.NODE_ENV;
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, 'helpers/agent-post-writes-cache-fixture.ts'),
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
  assert.ok(stdout.includes('AGENT_POST_CACHE_OK cases=5'), stdout);
  for (const line of stdout.split('\n')) {
    if (line.startsWith('AGENT_POST_CACHE_')) console.log(line);
  }
}, 30_000);
