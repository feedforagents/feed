// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadChatMessages } from "../src/web/store-world.ts";
import type { AppChatSummary, ViewerSession } from "../src/web/types.ts";

const viewer: ViewerSession = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  uiMode: "game",
  balanceCents: 0,
  startingGrantCents: 0,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

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
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
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
    }),
  );
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
