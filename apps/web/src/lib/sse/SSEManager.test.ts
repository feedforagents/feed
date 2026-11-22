import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SSEManager } from './SSEManager';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalEventSource = globalThis.EventSource;

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(_type: string, _listener: (event: unknown) => void): void {}

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  emitError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

const waitForAsyncWork = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('SSEManager token recovery', () => {
  beforeEach(() => {
    MockEventSource.instances = [];

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: () => {},
        removeEventListener: () => {},
        location: {
          origin: 'https://feed.test',
        },
      },
    });

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        onLine: true,
      },
    });

    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      value: MockEventSource,
    });
  });

  afterEach(() => {
    SSEManager.resetInstance();
    globalThis.fetch = originalFetch;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      value: originalEventSource,
    });
  });

  it('refetches a realtime token after a failed SSE handshake', async () => {
    let tokenIndex = 0;
    const fetchMock = mock(async () => {
      tokenIndex += 1;
      return new Response(
        JSON.stringify({
          token: `token-${tokenIndex}`,
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const manager = SSEManager.getInstance({
      reconnectDelay: 1,
      maxReconnectDelay: 1,
    });
    manager.setAuthProvider(async () => 'privy-token');
    manager.setAuthenticated(true);

    const unsubscribe = manager.subscribe('markets', () => {});
    await waitForAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(
      new URL(MockEventSource.instances[0]!.url).searchParams.get('token')
    ).toBe('token-1');

    MockEventSource.instances[0]!.emitError();
    await waitForAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(
      new URL(MockEventSource.instances[1]!.url).searchParams.get('token')
    ).toBe('token-2');

    unsubscribe();
  });

  it('keeps using the cached token after a disconnect on an established connection', async () => {
    let tokenIndex = 0;
    const fetchMock = mock(async () => {
      tokenIndex += 1;
      return new Response(
        JSON.stringify({
          token: `token-${tokenIndex}`,
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const manager = SSEManager.getInstance({
      reconnectDelay: 1,
      maxReconnectDelay: 1,
    });
    manager.setAuthProvider(async () => 'privy-token');
    manager.setAuthenticated(true);

    const unsubscribe = manager.subscribe('markets', () => {});
    await waitForAsyncWork();

    const firstConnection = MockEventSource.instances[0]!;
    firstConnection.emitOpen();
    firstConnection.emitError();
    await waitForAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(
      new URL(MockEventSource.instances[1]!.url).searchParams.get('token')
    ).toBe('token-1');

    unsubscribe();
  });

  it('includes a newly subscribed channel on an already open stream', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          token: 'token-1',
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const manager = SSEManager.getInstance({
      reconnectDelay: 1,
      maxReconnectDelay: 1,
    });
    manager.setAuthProvider(async () => 'privy-token');
    manager.setAuthenticated(true);

    const unsubscribeMarkets = manager.subscribe('markets', () => {});
    await waitForAsyncWork();
    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]!.emitOpen();

    const unsubscribeFeed = manager.subscribe('feed', () => {});
    await waitForAsyncWork();

    // The open socket was for markets only. A later subscriber must replace
    // it, or feed events never arrive.
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0]!.readyState).toBe(
      MockEventSource.CLOSED
    );
    const channels = new URL(
      MockEventSource.instances[1]!.url
    ).searchParams.get('channels');
    expect(channels?.split(',').sort()).toEqual(['feed', 'markets']);

    // Re-subscribing a channel the open stream already carries must not
    // open another connection.
    MockEventSource.instances[1]!.emitOpen();
    const unsubscribeMarketsAgain = manager.subscribe('markets', () => {});
    await waitForAsyncWork();
    expect(MockEventSource.instances).toHaveLength(2);

    unsubscribeMarkets();
    unsubscribeFeed();
    unsubscribeMarketsAgain();
  });

  it('opens a fresh stream for a new channel after reconnect attempts are exhausted', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          token: 'token-1',
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const manager = SSEManager.getInstance({
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      maxReconnectAttempts: 1,
    });
    manager.setAuthProvider(async () => 'privy-token');
    manager.setAuthenticated(true);

    manager.subscribe('markets', () => {});
    await waitForAsyncWork();
    MockEventSource.instances.at(-1)!.emitError();
    await waitForAsyncWork();
    MockEventSource.instances.at(-1)!.emitError();
    await waitForAsyncWork();

    expect(manager.getConnectionState()).toBe('disconnected');
    const givenUp = MockEventSource.instances.length;

    manager.subscribe('feed', () => {});
    await waitForAsyncWork();

    expect(MockEventSource.instances.length).toBe(givenUp + 1);
    const channels = new URL(
      MockEventSource.instances.at(-1)!.url
    ).searchParams.get('channels');
    expect(channels?.split(',').sort()).toEqual(['feed', 'markets']);
  });

  describe('pending token ownership', () => {
    const deferredTokenFetch = () => {
      const resolvers: Array<(r: Response) => void> = [];
      const fetchMock = mock(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const resolveNext = () =>
        resolvers.shift()?.(
          new Response(
            JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      return { fetchMock, resolveNext };
    };

    it('does not open a stream when unsubscribed while the token is pending', async () => {
      const { resolveNext } = deferredTokenFetch();
      const manager = SSEManager.getInstance();
      manager.setAuthProvider(async () => 'access');
      manager.setAuthenticated(true);

      const unsubscribe = manager.subscribe('markets', () => {});
      await waitForAsyncWork();
      unsubscribe();
      resolveNext();
      await waitForAsyncWork();

      expect(MockEventSource.instances).toHaveLength(0);
    });

    it('does not open a stream after destroy while the token is pending', async () => {
      const { resolveNext } = deferredTokenFetch();
      const manager = SSEManager.getInstance();
      manager.setAuthProvider(async () => 'access');
      manager.setAuthenticated(true);

      manager.subscribe('markets', () => {});
      await waitForAsyncWork();
      manager.destroy();
      resolveNext();
      await waitForAsyncWork();

      expect(MockEventSource.instances).toHaveLength(0);
    });

    it('a manual reconnect during a pending attempt starts a fresh one', async () => {
      const { fetchMock, resolveNext } = deferredTokenFetch();
      const manager = SSEManager.getInstance();
      manager.setAuthProvider(async () => 'access');
      manager.setAuthenticated(true);

      manager.subscribe('markets', () => {});
      await waitForAsyncWork();
      manager.reconnect();
      await waitForAsyncWork();
      resolveNext();
      resolveNext();
      await waitForAsyncWork();

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Only the latest attempt opens a stream.
      expect(MockEventSource.instances).toHaveLength(1);
    });
  });
});
