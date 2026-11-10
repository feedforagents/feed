import { describe, expect, test } from 'bun:test';
import { FEED_ABOUT, FEED_HOW_TO_PLAY } from '@feed/shared';
import { z } from 'zod';
import { FeedOAuthService, serveFeedMcp } from '../../mcp/src/index';

const origin = 'https://feed-body-test.example';
const service = new FeedOAuthService(origin);
const content = { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY };
const encoder = new TextEncoder();
const callBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'about_feed', arguments: {} },
});
function request(body: string | ReadableStream<Uint8Array>) {
  return new Request(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });
}

async function withTestDeadline<T>(operation: Promise<T>, cleanup: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('MCP whole-body deadline was not enforced'));
        }, 7000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('MCP bounded request body', () => {
  test('a complete JSON chunk that never closes is rejected after five seconds and canceled without awaiting cancellation', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
        source.enqueue(encoder.encode(callBody));
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => {});
      },
    });
    const started = Date.now();
    await expect(
      withTestDeadline(serveFeedMcp(request(stream), service, content), () =>
        controller?.error(new Error('test cleanup'))
      )
    ).rejects.toMatchObject({ code: 'invalid_request', status: 408 });
    expect(canceled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10000);

  test('continuously trickled chunks cannot reset the whole-body deadline', async () => {
    let chunks = 0;
    let canceled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
        source.enqueue(encoder.encode('{'));
        interval = setInterval(() => {
          chunks++;
          source.enqueue(encoder.encode(' '));
        }, 150);
      },
      cancel() {
        canceled = true;
        if (interval) clearInterval(interval);
      },
    });
    try {
      await expect(
        withTestDeadline(serveFeedMcp(request(stream), service, content), () =>
          controller?.error(new Error('test cleanup'))
        )
      ).rejects.toMatchObject({ code: 'invalid_request', status: 408 });
      expect(canceled).toBe(true);
      expect(chunks).toBeGreaterThan(3);
    } finally {
      if (interval) clearInterval(interval);
    }
  }, 10000);

  test('the byte cap rejects promptly even if the source cancellation never settles', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new Uint8Array(16385));
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => {});
      },
    });
    const started = Date.now();
    await expect(
      serveFeedMcp(request(stream), service, content)
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(canceled).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  test('normal chunked UTF-8 initialization and tool calls still succeed', async () => {
    const payload = encoder.encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client-🦞', version: '1' },
        },
      })
    );
    const emoji = payload.findIndex((byte) => byte === 0xf0);
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(payload.slice(0, emoji + 1));
        source.enqueue(payload.slice(emoji + 1));
        source.close();
      },
    });
    const initialized = await serveFeedMcp(request(stream), service, content);
    expect(initialized.status).toBe(200);
    expect(
      z
        .object({
          result: z.object({ serverInfo: z.object({ name: z.string() }) }),
        })
        .parse(await initialized.json()).result.serverInfo.name
    ).toBe('Feed');
    const called = await serveFeedMcp(request(callBody), service, content);
    expect(called.status).toBe(200);
    expect(JSON.stringify(await called.json())).toContain('Feed');
    await expect(
      serveFeedMcp(request('{'), service, content)
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });
});
