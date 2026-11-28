// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { transferGroupOwnership } from "../src/web/store-world.ts";
import type { AppChatSummary } from "../src/web/types.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function member(memberId: string, role: string) {
  return { memberId, memberKind: "user", handle: memberId, displayName: memberId, avatarUrl: null, role };
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

const serverChatBeforeTransfer = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "alice",
  memberCount: 3,
  unreadCount: 0,
  members: [member("alice", "owner"), member("bob", "member"), member("carol", "member")],
};

const serverChatAfterTransfer = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "bob",
  memberCount: 3,
  unreadCount: 0,
  members: [member("alice", "member"), member("bob", "owner"), member("carol", "member")],
};

function stubTransferWithChats(
  chats: () => Promise<Response>,
  transferStatus = 200,
): void {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1/transfer" && method === "POST") {
      return Promise.resolve(
        transferStatus === 200
          ? Response.json({ chat: serverChatAfterTransfer })
          : Response.json({ message: "Only the group owner can transfer ownership" }, { status: transferStatus }),
      );
    }
    if (url.pathname === "/api/chats") return chats();
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
}

function roleOf(memberId: string): string | undefined {
  return getStoreSnapshot()
    .chats.find((c) => c.id === "chat-1")
    ?.members.find((m) => m.memberId === memberId)?.role;
}

beforeEach(() => {
  setStoreState({
    viewer,
    route: "Chats",
    chats: [seedGroup()],
    selectedChatId: "chat-1",
    chatMessages: [],
    errorMessage: null,
    statusMessage: null,
    toasts: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the new owner in the member list after a successful transfer (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatAfterTransfer] })));

  const ok = await transferGroupOwnership("chat-1", "bob");

  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-1");
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Transferred group ownership to @bob.");
  expect(s.errorMessage).toBeNull();
  expect(chat?.isOwner).toBe(false);
  expect(roleOf("alice")).toBe("member");
  expect(roleOf("bob")).toBe("owner");
  expect(roleOf("carol")).toBe("member");
});

it("shows the new owner in the member list when the chat list reload fails after the transfer (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await transferGroupOwnership("chat-1", "bob");

  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-1");
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Transferred group ownership to @bob.");
  expect(chat?.isOwner).toBe(false);
  expect(roleOf("alice")).toBe("member");
  expect(roleOf("bob")).toBe("owner");
  expect(roleOf("carol")).toBe("member");
});

it("shows the new owner in the member list when the chat list reload returns the pre-transfer roster (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatBeforeTransfer] })));

  const ok = await transferGroupOwnership("chat-1", "bob");

  const chat = getStoreSnapshot().chats.find((c) => c.id === "chat-1");
  expect(ok).toBe(true);
  expect(chat?.isOwner).toBe(false);
  expect(roleOf("alice")).toBe("member");
  expect(roleOf("bob")).toBe("owner");
});

it("keeps the original owner in the member list when the transfer itself fails (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatBeforeTransfer] })), 403);

  const ok = await transferGroupOwnership("chat-1", "bob");

  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-1");
  expect(ok).toBe(false);
  expect(s.errorMessage).toBe("Only the group owner can transfer ownership");
  expect(chat?.isOwner).toBe(true);
  expect(roleOf("alice")).toBe("owner");
  expect(roleOf("bob")).toBe("member");
});
