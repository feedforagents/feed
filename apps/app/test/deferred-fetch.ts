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
    const url = new URL(raw, "https://feed.fun");
    const method = init?.method ?? "GET";
    return new Promise<Response>((resolve) => {
      pending.set(`${method} ${url.pathname}${url.search}`, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}
