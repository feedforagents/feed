/** PRD §§6.1/8.2/12, Phase 5: stable-snapshot cursor continuation. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { db, generateSnowflakeId, sql } from '@feed/db';

type OwnedChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

async function within<T>(
  promise: Promise<T>,
  ms: number,
  message: () => string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function exitedWithin(child: OwnedChild, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopOwnedChild(child: OwnedChild) {
  if (child.exitCode === null) child.kill('SIGTERM');
  if (!(await exitedWithin(child, 350))) {
    if (child.exitCode === null) child.kill('SIGKILL');
    assert.ok(
      await exitedWithin(child, 1500),
      'owned child did not exit after SIGKILL'
    );
  }
  await child.exited;
}

test('stories rail cursor traversal delivers every story exactly once', async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
  assert.equal(process.env.NODE_ENV, 'test');
  // Own a fresh schema inside the shared DB. Copy read layouts/indexes into
  // empty tables so whole-feed equality cannot depend on other published rows.
  const schema = `stories_rail_${await generateSnowflakeId()}`;
  const [settings] = await db.execute<{ search_path: string }>(
    sql`SHOW search_path`
  );
  assert.ok(settings);
  let acquired = false;
  let child: OwnedChild | undefined;
  let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const drains: Promise<void>[] = [];
  const drain = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    output: string[]
  ) => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output.push(decoder.decode(value, { stream: true }));
    }
    output.push(decoder.decode());
  };
  try {
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    acquired = true;
    const tables = await db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`
    );
    assert.ok(tables.length > 0, 'test DB schema has not been applied');
    for (const { tablename } of tables) {
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(schema)}.${sql.identifier(tablename)} (LIKE public.${sql.identifier(tablename)} INCLUDING ALL)`
      );
    }
    child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        resolve(import.meta.dir, 'helpers/stories-rail-cursor-fixture.ts'),
        schema,
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
          DATABASE_POOL_MAX: '1',
          DISABLE_RATE_LIMITING: 'true',
          FEED_DISABLE_REDIS: '1',
          REDIS_URL: '',
          ALLOW_TEST_PRIVY_DID_AUTH: 'false',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    stdoutReader = child.stdout.getReader();
    stderrReader = child.stderr.getReader();
    drains.push(drain(stdoutReader, stdout), drain(stderrReader, stderr));
    const [code] = await within(
      Promise.all([child.exited, ...drains]),
      45_000,
      () => `owned fixture timed out\n${stdout.join('')}\n${stderr.join('')}`
    );
    assert.ok(
      stdout.join('').includes('STORIES_RAIL_FIXTURE_OK rail'),
      `${stdout.join('')}\n${stderr.join('')}`
    );
    assert.equal(code, 0, `${stdout.join('')}\n${stderr.join('')}`);
  } finally {
    try {
      if (child) await stopOwnedChild(child);
      await within(
        Promise.allSettled([
          stdoutReader?.cancel(),
          stderrReader?.cancel(),
          ...drains,
        ]),
        1000,
        () => 'owned pipe teardown timed out'
      );
    } finally {
      if (acquired)
        await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
      await db.execute(
        sql`SELECT set_config('search_path', ${settings.search_path}, false)`
      );
    }
  }
}, 60_000);

test('owned child teardown escalates when its SIGTERM handler keeps it alive', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);",
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  const reader = child.stdout.getReader();
  try {
    const ready = await within(
      reader.read(),
      5000,
      () => 'owned child did not become ready'
    );
    assert.ok(new TextDecoder().decode(ready.value).includes('READY'));
    await stopOwnedChild(child);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    await stopOwnedChild(child);
    await within(
      Promise.allSettled([reader.cancel(), child.stderr.cancel()]),
      1000,
      () => 'owned test pipes did not close'
    );
  }
}, 10_000);
