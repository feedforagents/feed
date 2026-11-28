// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { removeGroupMember } from "../src/web/store-world.ts";
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

const serverChatAfterRemove = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [member("alice", "owner"), member("bob", "member")],
};

function stubRemoveWithChats(chats: () => Promise<Response>): void {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (/^\/api\/chats\/chat-1\/members\/carol$/.test(url.pathname) && method === "DELETE") {
      return Promise.resolve(Response.json({ chatId: "chat-1", memberId: "carol", removed: true }));
    }
    if (url.pathname === "/api/chats") return chats();
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
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

it("drops the removed member from the roster after a successful removal (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRemoveWithChats(() => Promise.resolve(Response.json({ chats: [serverChatAfterRemove] })));

  const ok = await removeGroupMember("chat-1", "carol");

  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-1");
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Member removed from group.");
  expect(s.errorMessage).toBeNull();
  expect(chat?.memberCount).toBe(2);
  expect(chat?.members.map((m) => m.memberId)).toEqual(["alice", "bob"]);
});

it("reports the failed roster refresh after a successful removal instead of silently keeping the removed member listed (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRemoveWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await removeGroupMember("chat-1", "carol");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Member removed from group.");
  expect(s.errorMessage).toBe("Member removed, but the member list failed to refresh.");
});
