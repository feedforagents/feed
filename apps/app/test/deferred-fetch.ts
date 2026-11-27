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
