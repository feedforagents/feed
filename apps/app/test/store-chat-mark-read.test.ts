// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { loadChatMessages, selectChat } from "../src/web/store-world.ts";
import type { AppChatSummary } from "../src/web/types.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function seedChat(unreadCount: number): AppChatSummary {
  return {
    id: "chat-1",
    chatType: "Direct",
    title: "Bob",
    subtitle: "@bob",
    memberCount: 2,
    unreadCount,
    lastMessagePreview: "hello",
    lastMessageAt: 2,
    peerAvatarUrl: null,
    peerHandle: "bob",
    members: [],
    isOwner: false,
    isBlocked: false,
  };
}

const bobMessage = {
  id: "m1",
  senderId: "bob",
  senderKind: "user",
  senderHandle: "bob",
  senderDisplayName: "Bob",
  content: "hello",
  createdAt: 2,
  reactions: [],
};

let readPosts: Array<string> = [];
let roomMessages: Array<Record<string, unknown>> = [bobMessage];

beforeEach(() => {
  readPosts = [];
  roomMessages = [bobMessage];
  stubFetchByUrl((url, init) => {
    if (url.pathname === "/api/chats/chat-1/messages" && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(Response.json({ messages: roomMessages }));
    }
    if (url.pathname === "/api/chats/chat-1/read" && init?.method === "POST") {
      readPosts.push(url.pathname);
      return Promise.resolve(
        Response.json({ chatId: "chat-1", accountId: "alice", lastReadAt: 2, unreadCount: 0 }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
  setStoreState({
    viewer,
    chats: [seedChat(0)],
    selectedChatId: "chat-1",
    chatMessages: [],
  });
});

it("marks the open room read even when the cached list badge is stale-zero (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  setStoreState({ chats: [seedChat(0)] });
  await loadChatMessages("chat-1");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["hello"]);
  expect(readPosts).toEqual(["/api/chats/chat-1/read"]);
});

it("still marks the open room read when the cached list badge says unread (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  setStoreState({ chats: [seedChat(1)] });
  await loadChatMessages("chat-1");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["hello"]);
  expect(readPosts).toEqual(["/api/chats/chat-1/read"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
});

it("does not mark read when the room loads with no messages (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  setStoreState({ chats: [seedChat(0)] });
  roomMessages = [];
  await loadChatMessages("chat-1");
  expect(getStoreSnapshot().chatMessages).toEqual([]);
  expect(readPosts).toEqual([]);
});

it("clears the list badge and keeps the switched-to room when a chat.message SSE event reloads the open room (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  let serverUnread = 1;
  const gate: {
    response: Response | null;
    release: ((response: Response) => void) | null;
    requested: (() => void) | null;
  } = { response: null, release: null, requested: null };
  const chatsRequested = new Promise<void>((resolve) => {
    gate.requested = resolve;
  });
  const postGate: { release: (() => void) | null } = { release: null };
  async function releaseReadPost(readCount: number): Promise<void> {
    for (
      let round = 0;
      round < 50 && readPosts.filter((path) => path === "/api/chats/chat-1/read").length < readCount;
      round += 1
    ) {
      await Promise.resolve();
    }
    for (let round = 0; round < 10; round += 1) {
      await Promise.resolve();
    }
    postGate.release?.();
  }
  const sseTarget = new EventTarget() as EventTarget & { close: () => void };
  sseTarget.close = () => {};
  function StubEventSource() {
    return sseTarget;
  }
  vi.stubGlobal("EventSource", StubEventSource);
  stubFetchByUrl((url, init) => {
    if (url.pathname === "/api/chats" && (init?.method ?? "GET") === "GET") {
        gate.response = Response.json({
          chats: [
            {
              id: "chat-1",
              kind: "direct",
              unreadCount: serverUnread,
              members: [{ memberId: "bob", handle: "bob", displayName: "Bob" }],
            },
            {
              id: "chat-2",
              kind: "direct",
              unreadCount: 0,
              members: [{ memberId: "carol", handle: "carol", displayName: "Carol" }],
            },
          ],
        });
        gate.requested?.();
        return new Promise((resolve) => {
          gate.release = resolve;
        });
      }
      if (url.pathname === "/api/chats/invites" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(Response.json({ invites: [] }));
      }
      if (url.pathname === "/api/chats/chat-1/messages" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(Response.json({ messages: roomMessages }));
      }
      if (url.pathname === "/api/chats/chat-2/messages" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          Response.json({ messages: [{ ...bobMessage, id: "m2", content: "from B" }] }),
        );
      }
      if (url.pathname === "/api/chats/chat-1/read" && init?.method === "POST") {
        readPosts.push(url.pathname);
        return new Promise<Response>((resolve) => {
          postGate.release = () => {
            serverUnread = 0;
            resolve(
              Response.json({ chatId: "chat-1", accountId: "alice", lastReadAt: 2, unreadCount: 0 }),
            );
          };
        });
      }
      if (url.pathname === "/api/chats/chat-2/read" && init?.method === "POST") {
        readPosts.push(url.pathname);
        return Promise.resolve(
          Response.json({ chatId: "chat-2", accountId: "alice", lastReadAt: 2, unreadCount: 0 }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
  setStoreState({ route: "Chats", chats: [seedChat(0)], selectedChatId: "chat-1" });
  reconnectRealtime();
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await releaseReadPost(1);
  await chatsRequested;
  const response = gate.response;
  expect(response).not.toBeNull();
  if (!response) return;
  gate.release?.(response);
  for (let round = 0; round < 50 && readPosts.length === 0; round += 1) {
    await Promise.resolve();
  }
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve();
  }
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["hello"]);
  expect(readPosts).toEqual(["/api/chats/chat-1/read"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
  serverUnread = 1;
  const secondChatsRequested = new Promise<void>((resolve) => {
    gate.requested = resolve;
  });
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await releaseReadPost(2);
  await secondChatsRequested;
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await selectChat("chat-2");
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  const secondResponse = gate.response;
  expect(secondResponse).not.toBeNull();
  if (!secondResponse) return;
  gate.release?.(secondResponse);
  for (let round = 0; round < 50; round += 1) {
    await Promise.resolve();
    const queuedResponse = gate.response;
    if (queuedResponse) gate.release?.(queuedResponse);
    postGate.release?.();
  }
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["from B"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
  expect(readPosts.filter((path) => path === "/api/chats/chat-1/read")).toHaveLength(2);
  expect(readPosts).toContain("/api/chats/chat-2/read");
  vi.unstubAllGlobals();
});
