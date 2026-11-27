import { vi } from "vitest";

export type Deferred = { resolve: (value: Response) => void };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installDeferredFetch() {
  const pending = new Map<string, Deferred>();
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://feed.fun");
    const method = init?.method ?? "GET";
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
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${new URL(raw, "https://feed.fun").href.replace("https://feed.fun", "")}`;
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
