// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
// (PRD §13: real-time SSE updates): a chat.reaction SSE signal that arrives while
// a Chats refresh is already in flight must not be dropped — the peer's open
// thread has to show the reaction once the in-flight refresh settles.
// Mirrors the Home-post queue case (open PR #2179), but the chat.* branch had no queue.
import { expect, it, vi } from "vitest";

it("Shows a chat reaction signaled while Chats is already refreshing", async () => {
  window.history.replaceState(null, "", "/chats");
  const { bootStore } = await import("../src/web/store.ts");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");

  const events = new EventTarget();
  class TestEventSource {
    addEventListener(type: string, listener: EventListener) {
      events.addEventListener(type, listener);
    }
    close() {}
  }

  const plainMsg = {
    id: "m1",
    senderId: "bob",
    senderKind: "user",
    senderHandle: "bob",
    senderDisplayName: "Bob",
    content: "hello",
    createdAt: 1,
    reactions: [],
  };
  const reactedMsg = {
    ...plainMsg,
    reactions: [{ emoji: "🔥", count: 1, reactedByViewer: false }],
  };
  const chat = {
    id: "chat-1",
    kind: "direct",
    title: "Bob",
    createdBy: "alice",
    memberCount: 2,
    lastMessagePreview: "hello",
  };

  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  let chatsCalls = 0;
  let messagesCalls = 0;

  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return Response.json({
        authenticated: true,
        viewer: { accountId: "alice", handle: "alice", displayName: "Alice", uiMode: "game" },
        acceptedCountries: [],
      });
    }
    if (path === "/api/skills/hosts") return Response.json({ hosts: [] });
    if (path === "/api/trending") return Response.json({ trending: [] });
    if (path === "/api/notifications") return Response.json({ notifications: [], unreadCount: 0 });
    if (path === "/api/chats/alpha-invites") return Response.json({ invites: [] });
    if (path === "/api/chats/chat-1/messages") {
      messagesCalls += 1;
      // Calls 1-2 read the pre-reaction snapshot; call 3+ (only reachable when
      // the queued reaction signal replays a refresh) sees the reaction.
      if (messagesCalls <= 2) return Response.json({ messages: [plainMsg] });
      return Response.json({ messages: [reactedMsg] });
    }
    if (path === "/api/chats") {
      chatsCalls += 1;
      if (chatsCalls === 2) {
        // The refresh triggered by the first signal: hold it open so the
        // reaction signal lands while sseRefreshPending is true.
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return Response.json({ chats: [chat] });
    }
    return Response.json({}, { status: 404 });
  });

  try {
    bootStore();
    await vi.waitFor(
      () => expect(getStoreSnapshot().chatMessages.map((m) => m.id)).toEqual(["m1"]),
      { timeout: 15000, interval: 50 },
    );
    expect(getStoreSnapshot().route).toBe("Chats");
    expect(getStoreSnapshot().chatMessages[0]?.reactions).toEqual([]);
    expect(chatsCalls).toBe(1);
    expect(messagesCalls).toBe(1);

    // First signal starts a refresh that blocks on /api/chats.
    events.dispatchEvent(new Event("chat.message"));
    await refreshStarted.promise;
    expect(chatsCalls).toBe(2);
    // The reaction lands while that refresh is still in flight.
    events.dispatchEvent(new Event("chat.reaction"));
    expect(chatsCalls).toBe(2);
    releaseRefresh.resolve();

    // After the in-flight refresh settles, the reaction must be visible.
    await vi.waitFor(
      () => expect(getStoreSnapshot().chatMessages[0]?.reactions).toEqual([
        { emoji: "🔥", count: 1, reacted: false },
      ]),
      { timeout: 15000, interval: 50 },
    );
    expect(messagesCalls).toBe(3);
  } finally {
    releaseRefresh.resolve();
    vi.unstubAllGlobals();
  }
});
