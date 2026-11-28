// @vitest-environment happy-dom
// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"
import { beforeEach, expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reactToChatMessage } from "../src/web/store-world.ts";
import type { AppChatSummary } from "../src/web/types.ts";
import { makeViewerSession, stubFetchByUrl } from "./app-test-helpers.tsx";

const viewer = makeViewerSession({ displayName: "Alice" });

function seedChat(): AppChatSummary {
  return {
    id: "chat-1",
    chatType: "Direct",
    title: "Bob",
    subtitle: "@bob",
    memberCount: 2,
    unreadCount: 0,
    lastMessagePreview: "hello",
    lastMessageAt: 2,
    peerAvatarUrl: null,
    peerHandle: "bob",
    members: [],
    isOwner: false,
    isBlocked: false,
  };
}

type ReactionSeed = { emoji: string; count: number; reacted: boolean };

function seedMessage(reactions: ReactionSeed[]) {
  return {
    id: "m1",
    senderName: "Bob",
    senderHandle: "bob",
    isNpc: false,
    isOwn: false,
    timestamp: "now",
    content: "hello",
    reactions,
  };
}

let reactionPostResult: () => Response = () =>
  Response.json({ messageId: "m1", chatId: "chat-1", accountId: "alice", emoji: "👍", added: true });
let messagesGetResult: () => Response = () =>
  Response.json({ message: "Reload exploded" }, { status: 500 });

beforeEach(() => {
  reactionPostResult = () =>
    Response.json({ messageId: "m1", chatId: "chat-1", accountId: "alice", emoji: "👍", added: true });
  messagesGetResult = () => Response.json({ message: "Reload exploded" }, { status: 500 });
  stubFetchByUrl((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/chats/chat-1/messages/m1/reactions" && method === "POST") {
      return Promise.resolve(reactionPostResult());
    }
    if (url.pathname === "/api/chats/chat-1/messages" && method === "GET") {
      return Promise.resolve(messagesGetResult());
    }
    if (url.pathname.endsWith("/read") && method === "POST") {
      return Promise.resolve(Response.json({ unreadCount: 0 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }, "http://localhost");
  setStoreState({
    viewer,
    chats: [seedChat()],
    selectedChatId: "chat-1",
    chatMessages: [seedMessage([])],
    toasts: [],
    errorMessage: null,
  });
});

it("shows an added reaction when the thread reload fails after the reaction commits (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  await reactToChatMessage("m1", "👍");
  const s = getStoreSnapshot();
  expect(s.chatMessages[0]?.reactions).toEqual([{ emoji: "👍", count: 1, reacted: true }]);
});

it("shows a removed reaction when the thread reload fails after the reaction toggle commits (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  reactionPostResult = () =>
    Response.json({ messageId: "m1", chatId: "chat-1", accountId: "alice", emoji: "👍", added: false });
  setStoreState({ chatMessages: [seedMessage([{ emoji: "👍", count: 2, reacted: true }])] });
  await reactToChatMessage("m1", "👍");
  const s = getStoreSnapshot();
  expect(s.chatMessages[0]?.reactions).toEqual([{ emoji: "👍", count: 1, reacted: false }]);
});

it("drops the reaction chip when the viewer's reaction was the only one and the reload fails (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  reactionPostResult = () =>
    Response.json({ messageId: "m1", chatId: "chat-1", accountId: "alice", emoji: "👍", added: false });
  setStoreState({ chatMessages: [seedMessage([{ emoji: "👍", count: 1, reacted: true }])] });
  await reactToChatMessage("m1", "👍");
  const s = getStoreSnapshot();
  expect(s.chatMessages[0]?.reactions).toEqual([]);
});

it("uses the reloaded thread when the reload succeeds after a reaction (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  messagesGetResult = () =>
    Response.json({
      messages: [
        {
          id: "m1",
          senderId: "bob",
          senderKind: "user",
          senderHandle: "bob",
          senderDisplayName: "Bob",
          content: "hello",
          createdAt: 2,
          reactions: [{ emoji: "👍", count: 3, reactedByViewer: true }],
        },
      ],
    });
  await reactToChatMessage("m1", "👍");
  const s = getStoreSnapshot();
  expect(s.chatMessages[0]?.reactions).toEqual([{ emoji: "👍", count: 3, reacted: true }]);
});

it("keeps the thread unchanged and reports the failure when the reaction itself is refused (spec/social/messaging.md, \"Story: Direct messages, chat messages, and reactions\")", async () => {
  reactionPostResult = () => Response.json({ message: "Reaction refused" }, { status: 403 });
  await reactToChatMessage("m1", "👍");
  const s = getStoreSnapshot();
  expect(s.chatMessages[0]?.reactions).toEqual([]);
  expect(s.errorMessage).toBe("Reaction refused");
});
