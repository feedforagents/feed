// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { loadChatMessages, selectChat, sendChatMessage } from "../src/web/store-world.ts";
import { decodeNotifications, type AppChatSummary } from "../src/web/types.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function fallbackReadOrNotFound(url: URL, method: string, readPosts: string[]): Promise<Response> {
  if (url.pathname.endsWith("/read") && method === "POST") {
    readPosts.push(url.pathname);
    return Promise.resolve(Response.json({ unreadCount: 0 }));
  }
  return Promise.resolve(Response.json({}, { status: 404 }));
}

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
let readResponse: () => Response = () => Response.json({ chatId: "chat-1", accountId: "alice", lastReadAt: 2, unreadCount: 0 });

beforeEach(() => {
  readPosts = [];
  roomMessages = [bobMessage];
  readResponse = () => Response.json({ chatId: "chat-1", accountId: "alice", lastReadAt: 2, unreadCount: 0 });
  stubFetchByUrl((url, init) => {
    if (url.pathname === "/api/chats/chat-1/messages" && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(Response.json({ messages: roomMessages }));
    }
    if (url.pathname === "/api/chats/chat-1/read" && init?.method === "POST") {
      readPosts.push(url.pathname);
      return Promise.resolve(readResponse());
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
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

it("clears the previous room's messages on switch and drops its late response without marking it read (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  const releases: { first?: () => void; second?: () => void } = {};
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1/messages" && method === "GET") {
      return new Promise<Response>((resolve) => {
        releases.first = () => resolve(Response.json({ messages: roomMessages }));
      });
    }
    if (url.pathname === "/api/chats/chat-2/messages" && method === "GET") {
      return new Promise<Response>((resolve) => {
        releases.second = () =>
          resolve(Response.json({ messages: [{ ...bobMessage, id: "m2", content: "from B" }] }));
      });
    }
    return fallbackReadOrNotFound(url, method, readPosts);
  }, "http://localhost");
  setStoreState({
    chats: [seedChat(1), { ...seedChat(1), id: "chat-2", title: "Carol", peerHandle: "carol" }],
    selectedChatId: "chat-2",
    chatMessages: [{ id: "m0", senderName: "Carol", senderHandle: "carol", isNpc: false, isOwn: false, timestamp: "now", content: "earlier B", reactions: [] }],
  });
  const loadingFirst = selectChat("chat-1");
  await Promise.resolve();
  expect(getStoreSnapshot().selectedChatId).toBe("chat-1");
  expect(getStoreSnapshot().chatMessages).toEqual([]);
  const loadingSecond = selectChat("chat-2");
  await Promise.resolve();
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  expect(getStoreSnapshot().chatMessages).toEqual([]);
  releases.second?.();
  await loadingSecond;
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["from B"]);
  releases.first?.();
  await loadingFirst;
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["from B"]);
  expect(readPosts).toEqual(["/api/chats/chat-2/read"]);
});

it("does not mark read when the room loads with no messages (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  setStoreState({ chats: [seedChat(0)] });
  roomMessages = [];
  await loadChatMessages("chat-1");
  expect(getStoreSnapshot().chatMessages).toEqual([]);
  expect(readPosts).toEqual([]);
});

it("clears the notification badge for the room's chat messages when the room is opened (spec/social/moderation.md, \"Story: In-app notifications and Social-mode presentation filtering\"; spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  const seeded = decodeNotifications({
    notifications: [
      {
        id: "notif-chat-1",
        kind: "chat_message",
        chatId: "chat-1",
        actorHandle: "bob",
        actorName: "Bob",
        title: "New direct message",
        read: false,
        createdAt: 1,
      },
      {
        id: "notif-follow-1",
        kind: "follow",
        actorHandle: "carol",
        actorName: "Carol",
        title: "Carol followed you",
        read: false,
        createdAt: 1,
      },
    ],
    unreadCount: 2,
  });
  setStoreState({
    chats: [seedChat(1)],
    notifications: seeded.items,
    unreadNotifications: seeded.unreadCount,
  });
  await loadChatMessages("chat-1");
  expect(readPosts).toEqual(["/api/chats/chat-1/read"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
  expect(getStoreSnapshot().notifications.find((n) => n.item.id === "notif-chat-1")?.item.read).toBe(true);
  expect(getStoreSnapshot().notifications.find((n) => n.item.id === "notif-follow-1")?.item.read).toBe(false);
  expect(getStoreSnapshot().unreadNotifications).toBe(1);
});

it("clears the list badge and keeps the switched-to room when a chat.message SSE event reloads the open room (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  let serverUnread = 1;
  const gate: {
    response: Response | null;
    release: ((response: Response) => void) | null;
    requested: (() => void) | null;
  } = { response: null, release: null, requested: null };
  const chatsRequested = new Promise<void>((resolve) => {
    gate.requested = resolve;
  });
  const postGate: { release: (() => void) | null } = { release: null };
  async function releaseReadPost(readCount: number): Promise<void> {
    for (
      let round = 0;
      round < 50 && readPosts.filter((path) => path === "/api/chats/chat-1/read").length < readCount;
      round += 1
    ) {
      await Promise.resolve();
    }
    for (let round = 0; round < 10; round += 1) {
      await Promise.resolve();
    }
    postGate.release?.();
  }
  const sseTarget = new EventTarget() as EventTarget & { close: () => void };
  sseTarget.close = () => {};
  function StubEventSource() {
    return sseTarget;
  }
  vi.stubGlobal("EventSource", StubEventSource);
  stubFetchByUrl((url, init) => {
    if (url.pathname === "/api/chats" && (init?.method ?? "GET") === "GET") {
        gate.response = Response.json({
          chats: [
            {
              id: "chat-1",
              kind: "direct",
              unreadCount: serverUnread,
              members: [{ memberId: "bob", handle: "bob", displayName: "Bob" }],
            },
            {
              id: "chat-2",
              kind: "direct",
              unreadCount: 0,
              members: [{ memberId: "carol", handle: "carol", displayName: "Carol" }],
            },
          ],
        });
        gate.requested?.();
        return new Promise((resolve) => {
          gate.release = resolve;
        });
      }
      if (url.pathname === "/api/chats/invites" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(Response.json({ invites: [] }));
      }
      if (url.pathname === "/api/chats/chat-1/messages" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(Response.json({ messages: roomMessages }));
      }
      if (url.pathname === "/api/chats/chat-2/messages" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          Response.json({ messages: [{ ...bobMessage, id: "m2", content: "from B" }] }),
        );
      }
      if (url.pathname === "/api/chats/chat-1/read" && init?.method === "POST") {
        readPosts.push(url.pathname);
        return new Promise<Response>((resolve) => {
          postGate.release = () => {
            serverUnread = 0;
            resolve(
              Response.json({ chatId: "chat-1", accountId: "alice", lastReadAt: 2, unreadCount: 0 }),
            );
          };
        });
      }
      if (url.pathname === "/api/chats/chat-2/read" && init?.method === "POST") {
        readPosts.push(url.pathname);
        return Promise.resolve(
          Response.json({ chatId: "chat-2", accountId: "alice", lastReadAt: 2, unreadCount: 0 }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
  setStoreState({ route: "Chats", chats: [seedChat(0)], selectedChatId: "chat-1" });
  reconnectRealtime();
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await releaseReadPost(1);
  await chatsRequested;
  const response = gate.response;
  expect(response).not.toBeNull();
  if (!response) return;
  gate.release?.(response);
  for (let round = 0; round < 50 && readPosts.length === 0; round += 1) {
    await Promise.resolve();
  }
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve();
  }
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["hello"]);
  expect(readPosts).toEqual(["/api/chats/chat-1/read"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
  serverUnread = 1;
  const secondChatsRequested = new Promise<void>((resolve) => {
    gate.requested = resolve;
  });
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await releaseReadPost(2);
  await secondChatsRequested;
  sseTarget.dispatchEvent(
    new MessageEvent("chat.message", { data: JSON.stringify({ chatId: "chat-1" }) }),
  );
  await selectChat("chat-2");
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  const secondResponse = gate.response;
  expect(secondResponse).not.toBeNull();
  if (!secondResponse) return;
  gate.release?.(secondResponse);
  for (let round = 0; round < 50; round += 1) {
    await Promise.resolve();
    const queuedResponse = gate.response;
    if (queuedResponse) gate.release?.(queuedResponse);
    postGate.release?.();
  }
  expect(getStoreSnapshot().selectedChatId).toBe("chat-2");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["from B"]);
  expect(getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
  expect(readPosts.filter((path) => path === "/api/chats/chat-1/read")).toHaveLength(2);
  expect(readPosts).toContain("/api/chats/chat-2/read");
  vi.unstubAllGlobals();
});

it("keeps the room the user switched to when a send in the previous room finishes (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  const gates: { send?: () => void; roomB?: () => void } = {};
  let listLoads = 0;
  let gateRoomB = false;
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats" && method === "GET") {
      listLoads += 1;
      return Promise.resolve(
        Response.json({
          chats: [
            { id: "chat-1", kind: "direct", unreadCount: 0, lastMessagePreview: roomMessages.at(-1)?.content, members: [{ memberId: "bob", handle: "bob", displayName: "Bob" }] },
            { id: "chat-2", kind: "direct", unreadCount: 0, members: [{ memberId: "carol", handle: "carol", displayName: "Carol" }] },
          ],
        }),
      );
    }
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    if (url.pathname === "/api/chats/chat-1/messages" && method === "POST") {
      const { content } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { content: string };
      return new Promise<Response>((resolve) => {
        gates.send = () => {
          roomMessages = [...roomMessages, { ...bobMessage, id: content, senderId: "alice", senderHandle: "alice", content }];
          resolve(Response.json({ ok: true }));
        };
      });
    }
    if (url.pathname === "/api/chats/chat-1/messages") return Promise.resolve(Response.json({ messages: roomMessages }));
    if (url.pathname === "/api/chats/chat-2/messages") {
      const reply = () => Response.json({ messages: [{ ...bobMessage, id: "m2", content: "from B" }] });
      if (!gateRoomB) return Promise.resolve(reply());
      return new Promise<Response>((resolve) => {
        gates.roomB = () => resolve(reply());
      });
    }
    return fallbackReadOrNotFound(url, method, readPosts);
  }, "http://localhost");
  setStoreState({ route: "Chats", chats: [seedChat(0)], selectedChatId: "chat-1", chatMessages: [] });
  const view = () => ({
    selected: getStoreSnapshot().selectedChatId,
    thread: getStoreSnapshot().chatMessages.map((m) => m.content),
    roomAPreview: getStoreSnapshot().chats.find((c) => c.id === "chat-1")?.lastMessagePreview,
  });
  async function sendInRoomA(content: string, whileSending: () => Promise<void> | void): Promise<void> {
    const loadsBefore = listLoads;
    const sending = sendChatMessage("chat-1", content);
    for (let round = 0; round < 50 && !gates.send; round += 1) await Promise.resolve();
    await whileSending();
    gates.send?.();
    gates.send = undefined;
    expect(await sending).toBe(true);
    for (let round = 0; round < 50 && listLoads === loadsBefore; round += 1) await Promise.resolve();
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
  }

  await sendInRoomA("stay in A", () => {});
  expect(view()).toEqual({ selected: "chat-1", thread: ["hello", "stay in A"], roomAPreview: "stay in A" });

  await sendInRoomA("sent before switching", () => selectChat("chat-2"));
  expect(view()).toEqual({ selected: "chat-2", thread: ["from B"], roomAPreview: "sent before switching" });

  await selectChat("chat-1");
  gateRoomB = true;
  let switching: Promise<void> = Promise.resolve();
  await sendInRoomA("sent while B loads", () => {
    switching = selectChat("chat-2");
  });
  gates.roomB?.();
  await switching;
  expect(view()).toEqual({ selected: "chat-2", thread: ["from B"], roomAPreview: "sent while B loads" });
});

it("surfaces a failed thread refresh after a successful send instead of silently hiding the sent message (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1/messages" && method === "POST") {
      return Promise.resolve(Response.json({ ok: true }, { status: 201 }));
    }
    if (url.pathname === "/api/chats/chat-1/messages" && method === "GET") {
      return Promise.resolve(Response.json({ message: "Reload exploded" }, { status: 500 }));
    }
    if (url.pathname === "/api/chats" && method === "GET") {
      return Promise.resolve(
        Response.json({
          chats: [
            { id: "chat-1", kind: "direct", unreadCount: 0, lastMessagePreview: "hello", members: [{ memberId: "bob", handle: "bob", displayName: "Bob" }] },
          ],
        }),
      );
    }
    if (url.pathname === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    return fallbackReadOrNotFound(url, method, readPosts);
  }, "http://localhost");
  setStoreState({
    chats: [seedChat(0)],
    selectedChatId: "chat-1",
    chatMessages: [{ id: "m1", senderName: "Bob", senderHandle: "bob", isNpc: false, isOwn: false, timestamp: "now", content: "hello", reactions: [] }],
    toasts: [],
    errorMessage: null,
  });
  expect(await sendChatMessage("chat-1", "sent but invisible")).toBe(true);
  const s = getStoreSnapshot();
  expect(s.chatMessages.map((m) => m.content)).toEqual(["hello"]);
  expect(s.toasts.map((t) => t.message)).toEqual(["Message sent, but the thread failed to refresh."]);
  expect(s.errorMessage).toBe("Message sent, but the thread failed to refresh.");
});

it("surfaces a failed message load when a conversation is opened instead of showing an empty thread (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1/messages" && method === "GET") {
      return Promise.resolve(Response.json({ message: "Load exploded" }, { status: 500 }));
    }
    return fallbackReadOrNotFound(url, method, readPosts);
  }, "http://localhost");
  setStoreState({
    chats: [seedChat(0)],
    selectedChatId: null,
    chatMessages: [],
    toasts: [],
    errorMessage: null,
  });
  await selectChat("chat-1");
  const s = getStoreSnapshot();
  expect(s.selectedChatId).toBe("chat-1");
  expect(s.chatMessages).toEqual([]);
  expect(s.toasts.map((t) => t.message)).toEqual(["Failed to load messages. Please try again."]);
  expect(s.errorMessage).toBe("Failed to load messages. Please try again.");
});

function seedChatNotifications() {
  const seeded = decodeNotifications({
    notifications: [
      { id: "notif-chat-1", kind: "chat_message", chatId: "chat-1", actorHandle: "bob", actorName: "Bob", title: "Bob sent a message", read: false, createdAt: 2 },
      { id: "notif-chat-2", kind: "chat_message", chatId: "chat-2", actorHandle: "carol", actorName: "Carol", title: "Carol sent a message", read: false, createdAt: 2 },
      { id: "notif-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: 2 },
    ],
    unreadCount: 3,
  });
  setStoreState({ notifications: seeded.items, unreadNotifications: 3 });
}

it("clears the open room's chat-message notifications and badge when the room is read (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\"; spec/social/moderation.md, \"Story: In-app notifications and Social-mode presentation filtering\")", async () => {
  setStoreState({ chats: [seedChat(1)] });
  seedChatNotifications();
  await loadChatMessages("chat-1");
  const s = getStoreSnapshot();
  expect(s.notifications.map((n) => `${n.item.id}:${n.item.read ? "r" : "u"}`)).toEqual([
    "notif-chat-1:r",
    "notif-chat-2:u",
    "notif-follow:u",
  ]);
  expect(s.unreadNotifications).toBe(2);
  expect(s.chats.find((c) => c.id === "chat-1")?.unreadCount).toBe(0);
});

it("keeps chat-message notifications unread when the room read request fails (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\"; spec/social/moderation.md, \"Story: In-app notifications and Social-mode presentation filtering\")", async () => {
  readResponse = () => Response.json({ message: "boom" }, { status: 500 });
  setStoreState({ chats: [seedChat(1)] });
  seedChatNotifications();
  await loadChatMessages("chat-1");
  const s = getStoreSnapshot();
  expect(s.notifications.every((n) => !n.item.read)).toBe(true);
  expect(s.unreadNotifications).toBe(3);
});
