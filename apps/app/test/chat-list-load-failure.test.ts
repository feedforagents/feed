// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadChats } from "../src/web/store-world.ts";
import { aliceViewer, resetModerationStore } from "./moderation-fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ chats: [], selectedChatId: null, chatsLoading: false, errorMessage: null });
});

function stubChatsFailure(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.startsWith("/api/chats/invites")) {
      return Promise.resolve(Response.json({ invites: [] }));
    }
    if (url.startsWith("/api/chats")) {
      return Promise.resolve(Response.json({ message: "Conversations unavailable" }, { status: 500 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

it('A failed conversation list load on opening Messages reports the failure instead of an empty list (spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions")', async () => {
  stubChatsFailure();
  setStoreState({
    viewer: aliceViewer,
    route: "Chats",
    chats: [],
    selectedChatId: null,
    chatsLoading: false,
    errorMessage: null,
  });

  await loadChats(true);

  const after = getStoreSnapshot();
  expect({
    chats: after.chats.map((c) => c.id),
    loading: after.chatsLoading,
    error: after.errorMessage,
  }).toEqual({
    chats: [],
    loading: false,
    error: "Conversations unavailable",
  });
});

it('A failed conversation list refresh keeps the loaded conversations and reports the failure (spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions")', async () => {
  stubChatsFailure();
  setStoreState({
    viewer: aliceViewer,
    route: "Chats",
    chats: [{
      id: "chat-1",
      chatType: "Direct",
      title: "Bob",
      subtitle: "@bob",
      memberCount: 2,
      unreadCount: 0,
      lastMessagePreview: "hello",
      lastMessageAt: 2,
      peerAvatarUrl: null,
      peerHandle: "bob",
      members: [],
      isOwner: false,
      isBlocked: false,
    }],
    selectedChatId: "chat-1",
    chatsLoading: false,
    errorMessage: null,
  });

  await loadChats(false);

  const after = getStoreSnapshot();
  expect({
    chats: after.chats.map((c) => c.id),
    loading: after.chatsLoading,
    error: after.errorMessage,
  }).toEqual({
    chats: ["chat-1"],
    loading: false,
    error: null,
  });
});
