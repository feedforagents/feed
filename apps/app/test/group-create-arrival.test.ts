// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { createGroupChat } from "../src/web/store-world.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function member(memberId: string, role: string) {
  return { memberId, memberKind: "user", handle: memberId, displayName: memberId, avatarUrl: null, role };
}

const createdChat = {
  id: "chat-new",
  kind: "group",
  title: "Alpha Crew",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [member("alice", "owner"), member("bob", "member")],
};

function stubCreateWithChats(chats: () => Promise<Response>, createStatus = 201): void {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/group" && method === "POST") {
      return Promise.resolve(
        createStatus === 201
          ? Response.json({ chat: createdChat }, { status: 201 })
          : Response.json({ message: "Group creation failed" }, { status: createStatus }),
      );
    }
    if (url.pathname === "/api/chats") return chats();
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    if (url.pathname === "/api/chats/chat-new/messages") return Promise.resolve(Response.json({ messages: [] }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
}

function expectGroupOnArrival(ok: boolean) {
  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-new");
  expect(ok).toBe(true);
  expect(s.selectedChatId).toBe("chat-new");
  expect(chat?.title).toBe("Alpha Crew");
  return { s, chat };
}

beforeEach(() => {
  setStoreState({
    viewer,
    route: "Chats",
    chats: [],
    selectedChatId: null,
    chatMessages: [],
    errorMessage: null,
    statusMessage: null,
    toasts: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the new group on arrival when the chat list reload succeeds (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubCreateWithChats(() => Promise.resolve(Response.json({ chats: [createdChat] })));

  const ok = await createGroupChat("Alpha Crew", ["bob"]);

  const { chat } = expectGroupOnArrival(ok);
  expect(chat?.members.map((m) => m.memberId)).toEqual(["alice", "bob"]);
});

it("shows the new group on arrival when the chat list reload fails after creation (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubCreateWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const ok = await createGroupChat("Alpha Crew", ["bob"]);

  const { s, chat } = expectGroupOnArrival(ok);
  expect(s.statusMessage).toBe("Created group \"Alpha Crew\".");
  expect(chat?.members.map((m) => m.memberId)).toEqual(["alice", "bob"]);
  expect(chat?.isOwner).toBe(true);
});

it("shows the new group on arrival when the chat list reload returns a stale list without it (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubCreateWithChats(() => Promise.resolve(Response.json({ chats: [] })));

  const ok = await createGroupChat("Alpha Crew", ["bob"]);

  expectGroupOnArrival(ok);
});

it("adds no group when the viewer signs out while creation is in flight (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/group" && method === "POST") {
      setStoreState({ viewer: null, chats: [], selectedChatId: null, chatMessages: [] });
      return Promise.resolve(Response.json({ chat: createdChat }, { status: 201 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");

  await createGroupChat("Alpha Crew", ["bob"]);

  const s = getStoreSnapshot();
  expect(s.viewer).toBeNull();
  expect(s.chats.find((c) => c.id === "chat-new")).toBeUndefined();
});

it("keeps the failure visible and adds no group when creation itself fails (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  stubCreateWithChats(() => Promise.resolve(Response.json({ chats: [] })), 500);

  const ok = await createGroupChat("Alpha Crew", ["bob"]);

  const s = getStoreSnapshot();
  expect(ok).toBe(false);
  expect(s.errorMessage).toBe("Group creation failed");
  expect(s.chats.find((c) => c.id === "chat-new")).toBeUndefined();
});
