// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { renameGroupChat } from "../src/web/store-world.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function member(memberId: string, role: string) {
  return { memberId, memberKind: "user", handle: memberId, displayName: memberId, avatarUrl: null, role };
}

function serverChat(title: string, unreadCount = 0) {
  return {
    id: "chat-1",
    kind: "group",
    title,
    createdBy: "alice",
    memberCount: 2,
    unreadCount,
    members: [member("alice", "owner"), member("bob", "member")],
  };
}

function stubRenameWithChats(chats: () => Promise<Response>, patchStatus = 200): void {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1" && method === "PATCH") {
      return Promise.resolve(
        patchStatus === 200
          ? Response.json({ chat: serverChat("New Name"), chatId: "chat-1", title: "New Name", name: "New Name" })
          : Response.json({ message: "Rename failed" }, { status: patchStatus }),
      );
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
    chats: [{
      id: "chat-1",
      chatType: "UserGroup",
      title: "Old Name",
      subtitle: "Group chat",
      memberCount: 2,
      unreadCount: 0,
      lastMessagePreview: null,
      lastMessageAt: null,
      peerAvatarUrl: null,
      peerHandle: null,
      members: [
        { memberId: "alice", memberKind: "user", handle: "alice", displayName: "Alice", avatarUrl: null, role: "owner" },
        { memberId: "bob", memberKind: "user", handle: "bob", displayName: "Bob", avatarUrl: null, role: "member" },
      ],
      isOwner: true,
      isBlocked: false,
    }],
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

it("shows the new group name on arrival when the chat list reload fails after a rename (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Renamed group to \"New Name\".");
  expect(s.chats.find((c) => c.id === "chat-1")?.title).toBe("New Name");
});

it("shows the new group name on arrival when the chat list reload returns the pre-rename list (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Old Name")] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.chats.find((c) => c.id === "chat-1")?.title).toBe("New Name");
});

it("keeps the fresh chat list when the reload already carries the new name (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("New Name", 3)] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.errorMessage).toBeNull();
  expect(s.chats.find((c) => c.id === "chat-1")?.title).toBe("New Name");
  expect(s.chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(3);
});

it("keeps a later rename that lands in the reload instead of overwriting it with the earlier one (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Third Name")] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.chats.find((c) => c.id === "chat-1")?.title).toBe("Third Name");
});

it("keeps the old name and reports the failure when the rename itself fails (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Old Name")] })), 500);

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(false);
  expect(s.errorMessage).toBe("Rename failed");
  expect(s.chats.find((c) => c.id === "chat-1")?.title).toBe("Old Name");
});
