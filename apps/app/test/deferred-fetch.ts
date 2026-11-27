import { vi } from "vitest";

export type Deferred = { resolve: (value: Response) => void };

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function installDeferredFetch() {
  const pending = new Map<string, Deferred>();
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "https://feed.fun").pathname;
    const method = init?.method ?? "GET";
    return new Promise<Response>((resolve) => {
      pending.set(`${method} ${path}`, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

export function installDeferredFetchQueue() {
  const queues = new Map<string, Array<Deferred>>();
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://feed.fun");
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    return new Promise<Response>((resolve) => {
      const queue = queues.get(key) ?? [];
      queue.push({ resolve });
      queues.set(key, queue);
    });
  };
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
