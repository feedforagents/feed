// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { startDirectChat } from "../src/web/store-world.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

const directChat = {
  id: "chat-2",
  kind: "direct",
  title: "Bob",
  unreadCount: 0,
  members: [
    { memberId: "alice", memberKind: "user", handle: "alice", displayName: "Alice", avatarUrl: null, role: "member" },
    { memberId: "bob", memberKind: "user", handle: "bob", displayName: "Bob", avatarUrl: null, role: "member" },
  ],
};

const carolChat = {
  id: "chat-9",
  kind: "direct",
  title: "Carol",
  unreadCount: 0,
  members: [
    { memberId: "alice", memberKind: "user", handle: "alice", displayName: "Alice", avatarUrl: null, role: "member" },
    { memberId: "carol", memberKind: "user", handle: "carol", displayName: "Carol", avatarUrl: null, role: "member" },
  ],
};

function stubDirectWithChats(chats: () => Promise<Response>, directStatus = 201): void {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/direct" && method === "POST") {
      return Promise.resolve(
        directStatus === 201
          ? Response.json({ chat: directChat }, { status: 201 })
          : Response.json({ message: "Direct chat failed" }, { status: directStatus }),
      );
    }
    if (url.pathname === "/api/chats") return chats();
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    if (url.pathname === "/api/chats/chat-2/messages") {
      return Promise.resolve(
        Response.json({
          messages: [
            {
              id: "m2",
              senderId: "bob",
              senderKind: "user",
              senderHandle: "bob",
              senderDisplayName: "Bob",
              content: "thread hello",
              createdAt: 3,
              reactions: [],
            },
          ],
        }),
      );
    }
    if (url.pathname.endsWith("/read") && method === "POST") {
      return Promise.resolve(Response.json({ unreadCount: 0 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
}

function expectDirectOnArrival(opened: boolean) {
  const s = getStoreSnapshot();
  const chat = s.chats.find((c) => c.id === "chat-2");
  expect(opened).toBe(true);
  expect(s.route).toBe("Chats");
  expect(s.selectedChatId).toBe("chat-2");
  expect(chat?.title).toBe("Bob");
  expect(chat?.peerHandle).toBe("bob");
  expect(s.chatMessages.map((m) => m.content)).toEqual(["thread hello"]);
  return { s, chat };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/chats");
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

it("shows the direct thread on arrival when the chat list reload succeeds (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubDirectWithChats(() => Promise.resolve(Response.json({ chats: [directChat] })));

  const opened = await startDirectChat("bob");

  expectDirectOnArrival(opened);
});

it("shows the direct thread on arrival when the chat list reload fails after the DM is created (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubDirectWithChats(() =>
    Promise.resolve(Response.json({ message: "Chats unavailable" }, { status: 500 })),
  );

  const opened = await startDirectChat("bob");

  expectDirectOnArrival(opened);
});

it("shows the direct thread on arrival when the chat list reload returns a stale list without the new DM (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubDirectWithChats(() => Promise.resolve(Response.json({ chats: [carolChat] })));

  const opened = await startDirectChat("bob");

  const { s } = expectDirectOnArrival(opened);
  expect(s.chats.map((c) => c.id)).toContain("chat-9");
});

it("keeps the arrival list unchanged when the DM creation is refused (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubDirectWithChats(() => Promise.resolve(Response.json({ chats: [] })), 500);

  const opened = await startDirectChat("bob");

  const s = getStoreSnapshot();
  expect(opened).toBe(false);
  expect(s.chats).toEqual([]);
  expect(s.selectedChatId).toBeNull();
  expect(s.errorMessage).toBe("Direct chat failed");
});
