// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import type { AppChatSummary, ViewerSession } from "../src/web/types.ts";

const viewer: ViewerSession = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game",
  balanceCents: 0,
  startingGrantCents: 0,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

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

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
      if (url.pathname === "/api/chats") return Promise.resolve(Response.json({ chats: [serverChatAfterLeave] }));
      if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
      if (url.pathname === "/api/chats/chat-1/messages") return Promise.resolve(Response.json({ messages: [] }));
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

it("still reloads chats on a chat.message event (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ type: "chat.message", chatId: "chat-1" }) }),
  );
  await waitForMemberCount(2);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.memberCount).toBe(2);
});
