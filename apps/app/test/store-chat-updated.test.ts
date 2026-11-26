// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import type { AppChatSummary } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function member(memberId: string, handle: string) {
  return { memberId, memberKind: "user", handle, displayName: handle, avatarUrl: null, role: "member" };
}

function seedGroup(): AppChatSummary {
  return {
    id: "chat-1",
    chatType: "UserGroup",
    title: "Group Chat",
    subtitle: "Group chat",
    memberCount: 3,
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    peerAvatarUrl: null,
    peerHandle: null,
    members: [
      { memberId: "alice", memberKind: "user", handle: "alice", displayName: "Alice", avatarUrl: null, role: "owner" },
      { memberId: "bob", memberKind: "user", handle: "bob", displayName: "Bob", avatarUrl: null, role: "member" },
      { memberId: "carol", memberKind: "user", handle: "carol", displayName: "Carol", avatarUrl: null, role: "member" },
    ],
    isOwner: true,
    isBlocked: false,
  };
}

const serverChatAfterLeave = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [member("alice", "alice"), member("bob", "bob")],
};

const serverSecondChat = {
  id: "chat-2",
  kind: "group",
  title: "Second Chat",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [member("alice", "alice"), member("bob", "bob")],
};

function seedSecondChat(): AppChatSummary {
  return { ...seedGroup(), id: "chat-2", title: "Second Chat", memberCount: 2 };
}

let removedFromOpenChat = false;

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

beforeEach(() => {
  removedFromOpenChat = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
      if (url.pathname === "/api/chats")
        return Promise.resolve(Response.json({ chats: removedFromOpenChat ? [serverSecondChat] : [serverChatAfterLeave] }));
      if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
      if (url.pathname === "/api/chats/chat-1/messages")
        return Promise.resolve(
          removedFromOpenChat ? Response.json({}, { status: 403 }) : Response.json({ messages: [] }),
        );
      if (url.pathname === "/api/chats/chat-2/messages")
        return Promise.resolve(
          Response.json({ messages: [{ id: "m2", senderId: "bob", senderHandle: "bob", content: "second chat hello" }] }),
        );
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  vi.stubGlobal("EventSource", StubEventSource);
  setStoreState({
    viewer,
    route: "Chats",
    chats: [seedGroup()],
    selectedChatId: "chat-1",
    chatMessages: [],
  });
  reconnectRealtime();
});

afterEach(() => {
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

async function waitForMemberCount(count: number): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.memberCount === count) return;
    await Promise.resolve();
  }
}

it("drops a member who left from the open group roster and count (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("chat.updated", {
      data: JSON.stringify({ type: "chat.updated", chatId: "chat-1", action: "member_left", actorId: "carol" }),
    }),
  );
  await waitForMemberCount(2);
  const chat = getStoreSnapshot().chats.find((c) => c.id === "chat-1");
  expect(chat?.memberCount).toBe(2);
  expect(chat?.members.map((m) => m.memberId)).toEqual(["alice", "bob"]);
});

it("shows the surviving chat's messages, not the removed chat's, when the viewer is removed from the open group (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  removedFromOpenChat = true;
  setStoreState({
    chats: [seedGroup(), seedSecondChat()],
    selectedChatId: "chat-1",
    chatMessages: [
      {
        id: "m1",
        senderName: "Bob",
        senderHandle: "bob",
        isNpc: false,
        isOwn: false,
        timestamp: "",
        content: "removed chat secret",
        reactions: [],
      },
    ],
  });
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("chat.updated", {
      data: JSON.stringify({ type: "chat.updated", chatId: "chat-1", action: "member_removed", actorId: "bob" }),
    }),
  );
  for (let round = 0; round < 200; round += 1) {
    const s = getStoreSnapshot();
    if (s.selectedChatId === "chat-2" && s.chatMessages.length > 0 && s.chatMessages[0]?.id === "m2") break;
    await Promise.resolve();
  }
  const s = getStoreSnapshot();
  expect(s.selectedChatId).toBe("chat-2");
  expect(s.chatMessages.map((m) => m.content)).toEqual(["second chat hello"]);
});

it("still reloads chats on a chat.message event (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ type: "chat.message", chatId: "chat-1" }) }),
  );
  await waitForMemberCount(2);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.memberCount).toBe(2);
});
