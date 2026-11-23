/**
 * API key usage writes must survive request cleanup and flusher races,
 * and stale replays must never move lastUsedAt back.
 *
 * Requires DATABASE_URL (disposable DB with schema applied) and
 * TEST_REDIS_URL (disposable Redis). Skipped when TEST_REDIS_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { db, eq, userApiKeys } from '@feed/db';
import { withRequestResources } from '@feed/shared/server/request-scope';
import IORedis from 'ioredis';

const redisUrl = process.env.TEST_REDIS_URL;
const HASH = 'api-key:last-used:updates';
const QUEUE = 'api-key:last-used:queue';

describe.skipIf(!redisUrl)('api key lastUsedAt flusher', () => {
  const realRedis = redisUrl ? new IORedis(redisUrl) : null;
  let onHmget: (() => Promise<void>) | null = null;
  let redisAvailable = true;

  // Wrap the real client so a test can inject a concurrent write between the
  // flusher reading timestamps and acknowledging them.
  const client = realRedis
    ? new Proxy(realRedis, {
        get(target, prop, receiver) {
          if (prop === 'hmget') {
            return async (...args: Parameters<IORedis['hmget']>) => {
              const result = await target.hmget(...args);
              if (onHmget) {
                const hook = onHmget;
                onHmget = null;
                await hook();
              }
              return result;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : null;

  const keyId = `flush-test-${crypto.randomUUID()}`;
  let flushLastUsedUpdates: () => Promise<number>;
  let apiKeys: typeof import('../../api/src/utils/api-keys');

  beforeAll(async () => {
    const redisModulePath = path.resolve(
      import.meta.dir,
      '../../api/src/redis/index.ts'
    );
    const actual = await import(redisModulePath);
    mock.module(redisModulePath, () => ({
      ...actual,
      getRedisClient: () => client,
      isRedisAvailable: () => redisAvailable,
    }));
    ({ flushLastUsedUpdates } = await import(
      '../../api/src/utils/api-key-lastused-flusher'
    ));
    apiKeys = await import('../../api/src/utils/api-keys');

    await realRedis!.del(HASH, QUEUE, 'api-key:last-used:flush-lock');
    await db.insert(userApiKeys).values({
      id: keyId,
      userId: `user-${keyId}`,
      keyHash: 'a'.repeat(64),
    });
  });

  afterAll(async () => {
    await db.delete(userApiKeys).where(eq(userApiKeys.id, keyId));
    await realRedis!.del(HASH, QUEUE);
    realRedis!.disconnect();
    mock.restore();
  });

  async function lastUsedAt(): Promise<Date | null> {
    const [row] = await db
      .select({ lastUsedAt: userApiKeys.lastUsedAt })
      .from(userApiKeys)
      .where(eq(userApiKeys.id, keyId));
    return row?.lastUsedAt ?? null;
  }

  async function enqueue(ts: Date): Promise<void> {
    await realRedis!
      .multi()
      .hset(HASH, keyId, ts.toISOString())
      .zadd(QUEUE, ts.getTime(), keyId)
      .exec();
  }

  it('keeps a newer timestamp written during the flush', async () => {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-01T00:05:00.000Z');
    await enqueue(t1);
    onHmget = () => enqueue(t2);

    expect(await flushLastUsedUpdates()).toBe(1);
    expect((await lastUsedAt())?.toISOString()).toBe(t1.toISOString());
    // The newer value was not acknowledged and is still pending.
    expect(await realRedis!.hget(HASH, keyId)).toBe(t2.toISOString());
    expect(await realRedis!.zscore(QUEUE, keyId)).not.toBeNull();

    expect(await flushLastUsedUpdates()).toBe(1);
    expect((await lastUsedAt())?.toISOString()).toBe(t2.toISOString());
    expect(await realRedis!.hget(HASH, keyId)).toBeNull();
    expect(await realRedis!.zscore(QUEUE, keyId)).toBeNull();
  });

  it('never moves lastUsedAt backwards on a stale replay', async () => {
    const before = await lastUsedAt();
    expect(before).not.toBeNull();
    await enqueue(new Date('2025-06-01T00:00:00.000Z'));

    expect(await flushLastUsedUpdates()).toBe(1);
    expect((await lastUsedAt())?.toISOString()).toBe(before!.toISOString());
  });

  it.each([
    'Redis',
    'Postgres',
  ] as const)('tracks the API key usage write to %s through request cleanup', async (backend) => {
    const apiKey = apiKeys.generateTestApiKey();
    const keyHash = apiKeys.hashApiKey(apiKey);
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await db.insert(userApiKeys).values({ id, userId, keyHash });
    redisAvailable = backend === 'Redis';
    try {
      const tasks: Promise<unknown>[] = [];
      await withRequestResources(
        async () => {
          expect(await apiKeys.validateUserApiKey(apiKey)).toEqual({ userId });
          return new Response(null, { status: 204 });
        },
        (task) => tasks.push(task)
      );
      await Promise.all(tasks);
      // The usage write and request cleanup are both registered.
      expect(tasks).toHaveLength(2);
      if (backend === 'Redis') {
        expect(await realRedis!.hget(HASH, id)).not.toBeNull();
        expect(await realRedis!.zscore(QUEUE, id)).not.toBeNull();
      } else {
        const [row] = await db
          .select({ lastUsedAt: userApiKeys.lastUsedAt })
          .from(userApiKeys)
          .where(eq(userApiKeys.id, id));
        expect(row?.lastUsedAt).toBeInstanceOf(Date);
      }
    } finally {
      redisAvailable = true;
      apiKeys.invalidateCachedKey(keyHash);
      await db.delete(userApiKeys).where(eq(userApiKeys.id, id));
      await realRedis!.hdel(HASH, id);
      await realRedis!.zrem(QUEUE, id);
    }
  });
});
