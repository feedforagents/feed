// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchAccounts } from "../src/web/store-world.ts";

type Deferred = {
  resolve: (value: Response) => void;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installDeferredFetch() {
  const pending = new Map<string, Deferred>();
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const query = new URL(raw, "https://feed.fun").searchParams.get("q") ?? "";
    return new Promise<Response>((resolve) => {
      pending.set(query, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

const alRows = {
  items: [
    { id: "albert", kind: "user", handle: "albert", displayName: "Albert Trader", bio: "", avatarUrl: null, viewerFollows: false },
  ],
};

const aliRows = {
  items: [
    { id: "alina", kind: "user", handle: "alina", displayName: "Alina Analyst", bio: "", avatarUrl: null, viewerFollows: false },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account search stale response", () => {
  it('a superseded search resolves to no applicable result instead of an empty list that wipes current suggestions (spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions")', async () => {
    const pending = installDeferredFetch();
    const first = searchAccounts("al");
    const second = searchAccounts("ali");
    pending.get("ali")?.resolve(jsonResponse(aliRows));
    const secondResult = await second;
    expect(secondResult?.accounts.map((entry) => entry.handle)).toEqual(["alina"]);
    pending.get("al")?.resolve(jsonResponse(alRows));
    const firstResult = await first;
    expect(firstResult).toBeNull();
  });

  it('a current search still returns its accounts (spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions")', async () => {
    const pending = installDeferredFetch();
    const only = searchAccounts("ali");
    pending.get("ali")?.resolve(jsonResponse(aliRows));
    const result = await only;
    expect(result?.accounts.map((entry) => entry.handle)).toEqual(["alina"]);
  });
});
