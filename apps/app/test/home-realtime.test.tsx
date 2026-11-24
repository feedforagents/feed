// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { expect, it, vi } from "vitest";
import { bootStore } from "../src/web/store.ts";
import { getStoreSnapshot } from "../src/web/store-core.ts";

it('Shows posts signaled while Home is already refreshing (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const events = new EventTarget();
  class TestEventSource {
    addEventListener(type: string, listener: EventListener) {
      events.addEventListener(type, listener);
    }
    close() {}
  }
  const original = { id: "live-original", content: "Original Home post" };
  const first = { id: "live-first", content: "First live Home post" };
  const second = { id: "live-second", content: "Second live Home post" };
  const third = { id: "live-third", content: "Third live Home post" };
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  let feedCalls = 0;

  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") return Response.json({ authenticated: false, viewer: null });
    if (path === "/api/skills/hosts") return Response.json({ hosts: [] });
    if (path === "/api/trending") return Response.json({ trending: [] });
    if (path === "/api/markets") return Response.json({ predictions: [], perps: [], positions: [], economy: null });
    if (path === "/api/explore") return Response.json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return Response.json({ leaderboard: [] });
    if (path === "/api/economy/packs") return Response.json({ packs: [] });
    if (path !== "/api/feed") return Response.json({}, { status: 404 });
    feedCalls += 1;
    if (feedCalls === 1) return Response.json([original]);
    if (feedCalls === 2) {
      const response = Response.json([first, original]);
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return response;
    }
    return Response.json([third, second, first, original]);
  });

  try {
    bootStore();
    await vi.waitFor(
      () => expect(getStoreSnapshot().feedPosts.map((post) => post.card.id)).toContain("live-original"),
      { timeout: 15000, interval: 50 },
    );
    expect(getStoreSnapshot().route).toBe("Home");

    events.dispatchEvent(new Event("post.created"));
    await refreshStarted.promise;
    events.dispatchEvent(new Event("post.created"));
    events.dispatchEvent(new Event("post.engagement"));
    expect(feedCalls).toBe(2);
    releaseRefresh.resolve();

    await vi.waitFor(
      () => expect(getStoreSnapshot().feedPosts.map((post) => post.card.id)).toEqual(["live-third", "live-second", "live-first", "live-original"]),
      { timeout: 15000, interval: 50 },
    );
    expect(feedCalls).toBe(3);
  } finally {
    releaseRefresh.resolve();
    vi.unstubAllGlobals();
  }
});
