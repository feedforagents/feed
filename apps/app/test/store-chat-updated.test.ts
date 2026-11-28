// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { respondGroupInvite } from "../src/web/store-world.ts";
import type { AppAlphaInvite, AppChatSummary } from "../src/web/types.ts";
import {
  makeGroupMember,
  makeSeedGroupChat,
  makeViewerSession,
  stubFetchByUrl,
} from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });


const serverChatAfterLeave = {
  id: "chat-1",
  kind: "group",
  title: "Group Chat",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [makeGroupMember("alice", "member"), makeGroupMember("bob", "member")],
};

const serverSecondChat = {
  id: "chat-2",
  kind: "group",
  title: "Second Chat",
  createdBy: "alice",
  memberCount: 2,
  unreadCount: 0,
  members: [makeGroupMember("alice", "member"), makeGroupMember("bob", "member")],
};

function seedSecondChat(): AppChatSummary {
  return { ...makeSeedGroupChat(), id: "chat-2", title: "Second Chat", memberCount: 2 };
}

let removedFromOpenChat = false;
let listsBothChats = false;

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
  listsBothChats = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
      if (url.pathname === "/api/chats")
        return Promise.resolve(Response.json({
            chats: removedFromOpenChat
              ? [serverSecondChat]
              : listsBothChats
                ? [serverChatAfterLeave, serverSecondChat]
                : [serverChatAfterLeave],
          }),);
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
    chats: [makeSeedGroupChat()],
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
    chats: [makeSeedGroupChat(), seedSecondChat()],
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

it("keeps the open group selected when another group is renamed (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  listsBothChats = true;
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("chat.updated", {
      data: JSON.stringify({ type: "chat.updated", chatId: "chat-2", action: "renamed", actorId: "bob" }),
    }),
  );
  for (let round = 0; round < 200 && getStoreSnapshot().chats.length < 2; round += 1) await Promise.resolve();
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
  const s = getStoreSnapshot();
  expect({ selected: s.selectedChatId, chats: s.chats.map((c) => c.id), thread: s.chatMessages }).toEqual({
    selected: "chat-1",
    chats: ["chat-1", "chat-2"],
    thread: [],
  });
});

const pendingInvite: AppAlphaInvite = {
  id: "inv-1",
  chatId: "chat-9",
  chatKind: "user_group",
  isAlpha: false,
  actorHandle: "bob",
  actorDisplayName: "Bob",
  actorAvatarUrl: null,
  chatTitle: "Alpha Crew",
  tier: null,
  status: "pending",
};

function stubInviteRespondFetch(
  respond: (call: number, inviteId: string) => Promise<Response>,
  invites: () => Promise<Response> = () => Promise.resolve(Response.json({ invites: [] })),
): { respondCalls: () => number } {
  let calls = 0;
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    const respondMatch = /^\/api\/chats\/invites\/([^/]+)\/respond$/.exec(url.pathname);
    if (respondMatch && method === "POST") {
      calls += 1;
      return respond(calls, respondMatch[1]);
    }
    if (url.pathname === "/api/chats") return Promise.resolve(Response.json({ chats: [serverChatAfterLeave] }));
    if (url.pathname === "/api/chats/invites") return invites();
    if (url.pathname === "/api/chats/chat-1/messages") return Promise.resolve(Response.json({ messages: [] }));
    if (url.pathname === "/api/notifications") return Promise.resolve(Response.json({ notifications: [], unreadCount: 0 }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
  return { respondCalls: () => calls };
}

it("a second respond for the same invite while the first is in flight raises no error (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  const releases: Array<() => void> = [];
  const stub = stubInviteRespondFetch((call) =>
    call === 1
      ? new Promise<Response>((resolve) => {
          releases.push(() => resolve(Response.json({ invite: { id: "inv-1", status: "accepted" } })));
        })
      : Promise.resolve(Response.json({ message: "Invite has already been responded to" }, { status: 409 })),
  );
  setStoreState({ alphaInvites: [pendingInvite], errorMessage: null, statusMessage: null, toasts: [] });
  const first = respondGroupInvite("inv-1", true);
  const second = respondGroupInvite("inv-1", true);
  releases.forEach((release) => release());
  await Promise.all([first, second]);
  const s = getStoreSnapshot();
  expect(stub.respondCalls()).toBe(1);
  expect(s.errorMessage).toBeNull();
  expect(s.toasts.some((t) => t.tone === "destructive")).toBe(false);
  expect(s.alphaInvites).toEqual([]);
});

it("clears the responded invite from the pending list before the refetch settles (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  let releaseInvites: (() => void) | undefined;
  stubInviteRespondFetch(
    () => Promise.resolve(Response.json({ invite: { id: "inv-1", status: "declined" } })),
    () =>
      new Promise<Response>((resolve) => {
        releaseInvites = () => resolve(Response.json({ invites: [] }));
      }),
  );
  setStoreState({ alphaInvites: [pendingInvite], errorMessage: null, statusMessage: null, toasts: [] });
  const responding = respondGroupInvite("inv-1", false);
  for (let round = 0; round < 50 && getStoreSnapshot().statusMessage === null; round += 1) await Promise.resolve();
  expect(getStoreSnapshot().alphaInvites).toEqual([]);
  releaseInvites?.();
  await responding;
  expect(getStoreSnapshot().errorMessage).toBeNull();
});

it("keeps the invite pending after a failed respond so it can be answered again (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  const stub = stubInviteRespondFetch((call) =>
    call === 1
      ? Promise.resolve(Response.json({ message: "Cannot accept invite from a blocked account" }, { status: 403 }))
      : Promise.resolve(Response.json({ invite: { id: "inv-1", status: "declined" } })),
  );
  setStoreState({ alphaInvites: [pendingInvite], errorMessage: null, statusMessage: null, toasts: [] });
  await respondGroupInvite("inv-1", true);
  expect(getStoreSnapshot().errorMessage).toBe("Cannot accept invite from a blocked account");
  expect(getStoreSnapshot().alphaInvites.map((inv) => inv.id)).toEqual(["inv-1"]);
  await respondGroupInvite("inv-1", false);
  expect(stub.respondCalls()).toBe(2);
  expect(getStoreSnapshot().alphaInvites).toEqual([]);
});

it("sends a respond for a second invite while the first is still in flight (spec/social/messaging.md, \"Story: Create groups, invite to alpha groups, respond to invites, and leave\")", async () => {
  const releases: Array<() => void> = [];
  const stub = stubInviteRespondFetch(
    (_call, inviteId) =>
      new Promise<Response>((resolve) => {
        releases.push(() => resolve(Response.json({ invite: { id: inviteId, status: "accepted" } })));
      }),
  );
  setStoreState({
    alphaInvites: [pendingInvite, { ...pendingInvite, id: "inv-2", chatId: "chat-10", chatTitle: "Beta Crew" }],
    errorMessage: null,
    statusMessage: null,
    toasts: [],
  });
  const first = respondGroupInvite("inv-1", true);
  const second = respondGroupInvite("inv-2", true);
  expect(stub.respondCalls()).toBe(2);
  releases.forEach((release) => release());
  await Promise.all([first, second]);
  expect(getStoreSnapshot().alphaInvites).toEqual([]);
  expect(getStoreSnapshot().errorMessage).toBeNull();
});
