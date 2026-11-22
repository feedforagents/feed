/** PRD §12 / MVP phase 5: first events must survive across new SSE channels. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import Redis from 'ioredis';
import { z } from 'zod';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const redisEnabled =
  Boolean(process.env.REDIS_URL) && process.env.FEED_DISABLE_REDIS !== '1';
const messageSchema = z.object({ data: z.object({ id: z.string() }) });
async function waitUntil(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

const scenarios = [
  {
    name: 'delivers both first events when two Redis streams start empty',
    seedHistory: false,
    publishAfterHeaders: false,
  },
  {
    name: 'retains events published immediately after headers for missing streams',
    seedHistory: false,
    publishAfterHeaders: true,
  },
  {
    name: 'retains new events published immediately after headers for populated streams',
    seedHistory: true,
    publishAfterHeaders: true,
  },
];

for (const scenario of scenarios) {
  test.skipIf(!redisEnabled)(
    scenario.name,
    async () => {
      const owner = await generateSnowflakeId();
      const agents = [await generateSnowflakeId(), await generateSnowflakeId()];
      const ownedUsers: string[] = [];
      const channels = agents.map((id) => `agent:${id}`);
      const keys = channels.map((channel) => `realtime:${channel}`);
      const redis = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: 1,
      });
      const abort = new AbortController();
      let ownsStreams = false;
      let pump: Promise<void> | undefined;
      try {
        assert.equal(await redis.exists(...keys), 0);
        ownsStreams = true;
        const insertedUsers = await db
          .insert(users)
          .values([
            {
              id: owner,
              username: `test-sse-owner-${owner}`,
              updatedAt: new Date(),
            },
            ...agents.map((id) => ({
              id,
              username: `test-sse-agent-${id}`,
              managedBy: owner,
              isAgent: true,
              updatedAt: new Date(),
            })),
          ])
          .returning({ id: users.id });
        ownedUsers.push(...insertedUsers.map((row) => row.id));
        if (scenario.seedHistory) {
          for (const [index, channel] of channels.entries()) {
            await redis.xadd(
              keys[index]!,
              '*',
              'payload',
              JSON.stringify({
                channel,
                type: 'sse-history-test',
                data: { id: `history-${agents[index]}` },
                timestamp: Date.now(),
              })
            );
          }
        }
        const tokenResponse = await fetch(`${baseUrl}/api/realtime/token`, {
          method: 'POST',
          headers: {
            authorization: `Bearer steward:test:${owner}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            channels,
            includeNotifications: false,
            ttlSeconds: 30,
          }),
        });
        assert.equal(tokenResponse.status, 200);
        const { token } = z
          .object({ token: z.string() })
          .parse(await tokenResponse.json());
        const query = new URLSearchParams({
          channels: channels.join(','),
          token,
        });
        const response = await fetch(`${baseUrl}/api/sse/events?${query}`, {
          signal: abort.signal,
        });
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let connected = false;
        const received: string[] = [];
        pump = (async () => {
          let pending = '';
          while (!abort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) return;
            pending += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = pending.indexOf('\n\n')) !== -1) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              if (frame.includes('event: connected\n')) connected = true;
              if (frame.includes('event: message\n')) {
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data: '))
                  .map((line) => line.slice(6))
                  .join('\n');
                received.push(messageSchema.parse(JSON.parse(data)).data.id);
              }
            }
          }
        })();
        if (!scenario.publishAfterHeaders) {
          await waitUntil(() => connected, 'SSE handshake did not complete');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const publications = redis.pipeline();
        for (const [index, channel] of channels.entries()) {
          publications.xadd(
            keys[index]!,
            '*',
            'payload',
            JSON.stringify({
              channel,
              type: 'sse-empty-stream-test',
              data: { id: agents[index] },
              timestamp: Date.now(),
            })
          );
        }
        const published = await publications.exec();
        assert.ok(published);
        for (const [error] of published) assert.equal(error, null);
        await waitUntil(
          () => received.length === 2,
          'An initial SSE event was lost'
        );
        expect(received.sort()).toEqual([...agents].sort());
      } finally {
        abort.abort();
        const cleanupResults = await Promise.allSettled([
          pump?.catch((error: Error) => {
            if (error.name !== 'AbortError') throw error;
          }),
          ownsStreams ? redis.del(...keys) : Promise.resolve(),
          ownedUsers.length
            ? db.delete(users).where(inArray(users.id, ownedUsers))
            : Promise.resolve(),
        ]);
        await redis.quit();
        for (const result of cleanupResults) {
          if (result.status === 'rejected') throw result.reason;
        }
      }
    },
    15_000
  );
}
