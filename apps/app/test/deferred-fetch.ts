import { vi } from "vitest";

export type Deferred = { resolve: (value: Response) => void };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fetchRequest(input: RequestInfo | URL, init?: RequestInit): { url: URL; method: string } {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return { url: new URL(raw, "https://feed.fun"), method: init?.method ?? "GET" };
}

export function installFetch(handler: (url: URL, method: string) => Promise<Response>): void {
  const fetchMock: typeof fetch = (input, init) => {
    const { url, method } = fetchRequest(input, init);
    return handler(url, method);
  };
  vi.stubGlobal("fetch", fetchMock);
}

export function unexpectedResponse(url: URL, method: string): Promise<Response> {
  return Promise.resolve(jsonResponse({ message: `unexpected ${method} ${url.pathname}` }, 500));
}

export function installDeferredFetch() {
  const pending = new Map<string, Deferred>();
  const fetchMock: typeof fetch = (input, init) => {
    const { url, method } = fetchRequest(input, init);
    return new Promise<Response>((resolve) => {
      pending.set(`${method} ${url.pathname}${url.search}`, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

export function installDeferredFetchQueue() {
  const queues = new Map<string, Array<Deferred>>();
  const fetchMock: typeof fetch = (input, init) =>
    new Promise<Response>((resolve) => {
      const { url, method } = fetchRequest(input, init);
      const key = `${method} ${url.pathname}${url.search}`;
      const held = queues.get(key);
      if (held) held.push({ resolve });
      else queues.set(key, [{ resolve }]);
    });
  vi.stubGlobal("fetch", fetchMock);
  return {
    resolveOldest(key: string, res: Response): void {
      queues.get(key)?.shift()?.resolve(res);
    },
    resolveNewest(key: string, res: Response): void {
      queues.get(key)?.pop()?.resolve(res);
    },
  };
}

export function marketsResponse(status: number): Response {
  if (status !== 200) return jsonResponse({ message: "Markets unavailable" }, status);
  return jsonResponse({
    predictions: [],
    perps: [],
    positions: {
      predictionPositions: [
        {
          marketId: "pred-a",
          side: "yes",
          shares: 4000,
          costBasisCents: 2500,
          estimatedValueCents: 2500,
          question: "Will pred-a happen?",
          yesPriceBps: 5000,
          noPriceBps: 5000,
          settledAt: null,
        },
      ],
    },
  });
}

export function feedPost(id: string) {
  return { id, authorId: "acct-bob", authorHandle: "bob", authorDisplayName: "Bob", content: `post ${id}`, createdAt: "2026-11-27T00:00:00.000Z" };
}

export function feedErrorResponse(): Response {
  return new Response(JSON.stringify({ message: "Feed unavailable" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
