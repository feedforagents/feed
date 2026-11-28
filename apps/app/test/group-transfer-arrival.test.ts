// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { transferGroupOwnership } from "../src/web/store-world.ts";
import {
  makeGroupMember,
  makeSeedGroupChat,
  makeViewerSession,
  seedChatsRouteState,
  stubGroupMutationWithChats,
} from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

const serverChatBeforeTransfer = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "alice",
  memberCount: 3,
  unreadCount: 0,
  members: [makeGroupMember("alice", "owner"), makeGroupMember("bob", "member"), makeGroupMember("carol", "member")],
};

const serverChatAfterTransfer = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "bob",
  memberCount: 3,
  unreadCount: 0,
  members: [makeGroupMember("alice", "member"), makeGroupMember("bob", "owner"), makeGroupMember("carol", "member")],
};

function stubTransferWithChats(chats: () => Promise<Response>, transferStatus = 200): void {
  stubGroupMutationWithChats(
    "/api/chats/chat-1/transfer",
    "POST",
    () =>
      Promise.resolve(
        transferStatus === 200
          ? Response.json({ chat: serverChatAfterTransfer })
          : Response.json({ message: "Only the group owner can transfer ownership" }, { status: transferStatus }),
      ),
    chats,
  );
}

function expectArrivalRoles(isOwner: boolean, aliceRole: string, bobRole: string): void {
  const chat = getStoreSnapshot().chats.find((c) => c.id === "chat-1");
  expect(chat?.isOwner).toBe(isOwner);
  expect(chat?.members.find((m) => m.memberId === "alice")?.role).toBe(aliceRole);
  expect(chat?.members.find((m) => m.memberId === "bob")?.role).toBe(bobRole);
}

beforeEach(() => {
  seedChatsRouteState(viewer, [makeSeedGroupChat()], "chat-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the new owner in the member list after a successful transfer (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatAfterTransfer] })));

  const ok = await transferGroupOwnership("chat-1", "bob");

  const s = getStoreSnapshot();
  expect(ok).toBe(true);
  expect(s.statusMessage).toBe("Transferred group ownership to @bob.");
  expect(s.errorMessage).toBeNull();
  expectArrivalRoles(false, "member", "owner");
  expect(s.chats.find((c) => c.id === "chat-1")?.members.find((m) => m.memberId === "carol")?.role).toBe("member");
});

it("shows the new owner in the member list when the chat list reload fails after the transfer (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await transferGroupOwnership("chat-1", "bob");

  expect(ok).toBe(true);
  expect(getStoreSnapshot().statusMessage).toBe("Transferred group ownership to @bob.");
  expectArrivalRoles(false, "member", "owner");
});

it("shows the new owner in the member list when the chat list reload returns the pre-transfer roster (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatBeforeTransfer] })));

  const ok = await transferGroupOwnership("chat-1", "bob");

  expect(ok).toBe(true);
  expectArrivalRoles(false, "member", "owner");
});

it("keeps the original owner in the member list when the transfer itself fails (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubTransferWithChats(() => Promise.resolve(Response.json({ chats: [serverChatBeforeTransfer] })), 403);

  const ok = await transferGroupOwnership("chat-1", "bob");

  expect(ok).toBe(false);
  expect(getStoreSnapshot().errorMessage).toBe("Only the group owner can transfer ownership");
  expectArrivalRoles(true, "owner", "member");
});

it("keeps the new account's owner controls when the viewer switches accounts during the transfer (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  const bobViewer = makeViewerSession({ accountId: "bob", handle: "bob", displayName: "Bob" });
  const bobSeed = {
    ...makeSeedGroupChat(),
    members: makeSeedGroupChat().members.map((m) => ({ ...m, role: m.memberId === "bob" ? "owner" : "member" })),
  };
  stubGroupMutationWithChats(
    "/api/chats/chat-1/transfer",
    "POST",
    () => {
      seedChatsRouteState(bobViewer, [bobSeed], "chat-1");
      return Promise.resolve(Response.json({ chat: serverChatAfterTransfer }));
    },
    () => Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await transferGroupOwnership("chat-1", "bob");

  expect(ok).toBe(true);
  expectArrivalRoles(true, "member", "owner");
});
