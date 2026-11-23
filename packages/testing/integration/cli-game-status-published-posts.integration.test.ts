/** Phase 0 operator checks must reflect recent published activity (PRD §9.7). */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const description =
  'reports recent posts by publication time and excludes deleted posts';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks game status in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'cli-game-status-published-posts',
      file: 'packages/testing/integration/cli-game-status-published-posts.integration.test.ts',
      cases: [description],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { db, posts } = await import('@feed/db');
  const leaseFile = process.env.FEED_SUB_MARKET_LEASE_FILE;
  if (!leaseFile) throw new Error('Expected a verified lease file');
  const leaseDirectory = dirname(leaseFile);
  const cli = resolve(import.meta.dir, '../../../apps/cli/src/index.ts');

  async function status() {
    const processResult = Bun.spawn(
      [process.execPath, '--no-env-file', 'run', cli, 'status', 'game'],
      {
        cwd: leaseDirectory,
        env: {
          DATABASE_URL: process.env.DATABASE_URL,
          DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
          NODE_ENV: 'test',
          FEED_DISABLE_REDIS: '1',
          DISABLE_SENTRY: 'true',
          TZ: 'UTC',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [output, diagnostics, exitCode] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    expect(exitCode).toBe(0);
    return { output, diagnostics };
  }

  test(description, async () => {
    const authorId = randomUUID();
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 60_000);
    const future = new Date(now.getTime() + 20 * 60_000);

    await db.insert(posts).values([
      {
        id: randomUUID(),
        authorId,
        content: 'Scheduled post',
        createdAt: now,
        timestamp: future,
      },
      {
        id: randomUUID(),
        authorId,
        content: 'Backfilled post',
        createdAt: now,
        timestamp: old,
      },
      {
        id: randomUUID(),
        authorId,
        content: 'Deleted post',
        createdAt: now,
        timestamp: now,
        deletedAt: now,
      },
    ]);

    const emptyWindow = await status();
    console.log(
      emptyWindow.output.split('\n').find((line) => line.startsWith('Posts:'))
    );
    expect(emptyWindow.output).toContain('Posts: 3 total, 0 in last 5 minutes');
    expect(emptyWindow.diagnostics).toContain('No recent posts');

    await db.insert(posts).values({
      id: randomUUID(),
      authorId,
      content: 'Recently published article',
      type: 'article',
      createdAt: old,
      timestamp: now,
    });

    const updatedWindow = await status();
    console.log(
      updatedWindow.output.split('\n').find((line) => line.startsWith('Posts:'))
    );
    expect(updatedWindow.output).toContain(
      'Posts: 4 total, 1 in last 5 minutes'
    );
    expect(updatedWindow.output).toContain('Content is being generated');
  });
}
