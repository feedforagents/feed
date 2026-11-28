// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { renameGroupChat } from "../src/web/store-world.ts";
import {
  makeGroupMember,
  makeSeedGroupChat,
  makeViewerSession,
  seedChatsRouteState,
  stubGroupMutationWithChats,
} from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function serverChat(title: string, unreadCount = 0) {
  return {
    id: "chat-1",
    kind: "group",
    title,
    createdBy: "alice",
    memberCount: 2,
    unreadCount,
    members: [makeGroupMember("alice", "owner"), makeGroupMember("bob", "member")],
  };
}

function stubRenameWithChats(chats: () => Promise<Response>, patchStatus = 200): void {
  const renamed = { chat: serverChat("New Name"), chatId: "chat-1", title: "New Name", name: "New Name" };
  stubGroupMutationWithChats("/api/chats/chat-1", "PATCH", () =>
    Promise.resolve(
      patchStatus === 200 ? Response.json(renamed) : Response.json({ message: "Rename failed" }, { status: patchStatus }),
    ), chats);
}

function arrivalTitle(): string | undefined {
  return getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.title;
}

beforeEach(() => {
  const seed = { ...makeSeedGroupChat(), title: "Old Name", memberCount: 2, members: makeSeedGroupChat().members.slice(0, 2) };
  seedChatsRouteState(viewer, [seed], "chat-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the new group name on arrival when the chat list reload fails after a rename (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await renameGroupChat("chat-1", "New Name");

  expect(ok).toBe(true);
  expect(getStoreSnapshot().statusMessage).toBe("Renamed group to \"New Name\".");
  expect(arrivalTitle()).toBe("New Name");
});

it("shows the new group name on arrival when the chat list reload returns the pre-rename list (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Old Name")] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  expect(ok).toBe(true);
  expect(arrivalTitle()).toBe("New Name");
});

it("keeps the fresh chat list when the reload already carries the new name (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("New Name", 3)] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.errorMessage).toBeNull();
  expect(arrivalTitle()).toBe("New Name");
  expect(s.chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(3);
});

it("keeps a later rename that lands in the reload instead of overwriting it with the earlier one (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Third Name")] })));

  const ok = await renameGroupChat("chat-1", "New Name");

  expect(ok).toBe(true);
  expect(arrivalTitle()).toBe("Third Name");
});

it("keeps the old name and reports the failure when the rename itself fails (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubRenameWithChats(() => Promise.resolve(Response.json({ chats: [serverChat("Old Name")] })), 500);

  const ok = await renameGroupChat("chat-1", "New Name");

  expect(ok).toBe(false);
  expect(getStoreSnapshot().errorMessage).toBe("Rename failed");
  expect(arrivalTitle()).toBe("Old Name");
});
