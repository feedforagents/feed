/** PRD §§8.2/9.3, MVP Phase 6: retained market-history pagination. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';

test('perp history owns its schema, rows, memory cache and public-read quota', async () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  );
  const control = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const schema = `f36_${randomUUID().replaceAll('-', '')}`;
  let acquired = false;
  try {
    // The real route resolves AMZN through the immutable static registry.
    // A new schema isolates that canonical market instead of replacing the
    // registry or clearing any pre-existing public market/trade rows.
    await control`CREATE SCHEMA ${control(schema)}`;
    acquired = true;
    const tables = await control<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    assert.ok(tables.length > 0);
    for (const { tablename } of tables) {
      await control`CREATE TABLE ${control(schema)}.${control(tablename)} (LIKE public.${control(tablename)} INCLUDING ALL)`;
    }
    const child = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        resolve(import.meta.dir, 'helpers/perp-trades-order-fixture.ts'),
        schema,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          NODE_ENV: 'test',
          BUN_ENV: 'test',
          TZ: 'UTC',
          CI: 'false',
          DATABASE_URL: databaseUrl,
          DIRECT_DATABASE_URL: databaseUrl,
          DATABASE_POOL_MAX: '1',
          DATABASE_READ_REPLICA_URL: '',
          DISABLE_RATE_LIMITING: 'false',
          FEED_DISABLE_REDIS: '1',
          REDIS_URL: '',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }
    );
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    assert.ok(child.success, `${stdout}\n${stderr}`);
    assert.ok(stdout.includes('F36_OK cases=4'), stdout);
    for (const line of stdout.split('\n'))
      if (line.startsWith('F36_CASE_OK')) console.log(line);
  } finally {
    // spawnSync has waited for exit, including its bounded SIGKILL timeout.
    try {
      if (acquired) {
        await control`DROP SCHEMA ${control(schema)} CASCADE`;
        assert.equal(
          (await control`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`)
            .length,
          0
        );
      }
    } finally {
      await control.end({ timeout: 1 });
    }
  }
}, 45_000);
