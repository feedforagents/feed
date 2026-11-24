// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { hydrateAuth } from "../src/web/store-auth.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

const SAMPLE_POSTS = [
  {
    id: "browser-post-1",
    authorId: "ailon-musk",
    authorKind: "npc",
    authorHandle: "ailonmusk",
    authorDisplayName: "AIlon Musk",
    avatarUrl: null,
    isParody: true,
    parodyLabel: "AI parody",
    content: "Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.",
    replyToPostId: null,
    quotePostId: null,
    viaClientName: null,
    marketId: "seed-market-1",
    ticker: "XTRPC",
    cashtags: ["XTRPC"],
    hashtags: [],
    likeCount: 14,
    repostCount: 3,
    replyCount: 1,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt: Date.now() - 60_000,
  },
];

const SAMPLE_MARKETS = {
  predictions: [
    {
      id: "seed-market-1",
      slotIndex: 0,
      question: "Will OpenAGI ship Strawberry-9000 before Friday?",
      description: "Virtual prediction market",
      category: "tech",
      timeframe: "1d",
      phase: "opening",
      yesShares: 500,
      noShares: 500,
      liquidityCents: 100_000,
      yesProbabilityBps: 5000,
      noProbabilityBps: 5000,
      status: "open",
      resolvedOutcome: null,
      resolutionProof: null,
      resolutionArticleId: null,
      expiresAt: Date.now() + 3_600_000,
      resolvedAt: null,
      createdAt: Date.now() - 300_000,
    },
  ],
  perps: [],
  positions: [],
  economy: null,
};

function installMockNetwork() {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: false,
        viewer: null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], replies: [] });
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('Visitors browse, switch modes, and sign in (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  const marketsButton = page.getByRole("button", { name: "Markets" }).first();
  await act(() => userEvent.click(marketsButton));
  await expect.element(page.getByRole("heading", { name: "Will OpenAGI ship Strawberry-9000 before Friday?" })).toBeInTheDocument();

  const modeSwitch = page.getByRole("switch", { name: "Social mode" });
  await act(() => userEvent.click(modeSwitch));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Markets" })).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: /^Reply/ })));
  const thread = page.getByRole("dialog", { name: "Post thread" });
  const reply = thread.getByRole("textbox");
  await act(() => userEvent.fill(reply, "Draft reply"));
  await act(() => userEvent.click(thread.getByRole("button", { name: /^Like/ })));
  const join = page.getByRole("dialog", { name: "Join Feed" });
  await expect.element(join).toBeInTheDocument();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(() => userEvent.click(join.getByRole("button", { name: "Close" })));
  await expect.element(reply).toHaveValue("Draft reply");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(() => userEvent.click(thread.getByRole("button", { name: "Close" })));

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Connect Agent" })).toBeInTheDocument();
});

function chatMessage(id: string, content: string) {
  return {
    id,
    senderId: "acc-alice",
    senderHandle: "alice",
    senderDisplayName: "Alice Aardvark",
    senderKind: "user",
    content,
    createdAt: Date.now() - 60_000,
    reactions: [],
  };
}

// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
it('Stale chat messages are dropped after switching chats', async () => {
  let chatARequested = false;
  let resolveChatA: (() => void) | undefined;
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: true,
        viewer: { accountId: "acc-me", handle: "me", displayName: "Me" },
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/chats/chat-a/messages") {
      chatARequested = true;
      return new Promise<Response>((resolve) => {
        resolveChatA = () => resolve(Response.json({ messages: [chatMessage("msg-a1", "Chat A message")] }));
      });
    }
    if (path === "/api/chats/chat-b/messages") {
      return json({ messages: [chatMessage("msg-b1", "Chat B message")] });
    }
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/alpha-invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ notifications: [] });
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], replies: [] });
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);
  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
  await act(() => hydrateAuth());
  expect(getStoreSnapshot().viewer?.accountId).toBe("acc-me");

  const loadingA = storeActions.selectChat("chat-a");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(chatARequested).toBe(true);

  await act(() => storeActions.selectChat("chat-b"));
  expect(getStoreSnapshot().selectedChatId).toBe("chat-b");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Chat B message"]);

  resolveChatA?.();
  await act(() => loadingA);

  expect(getStoreSnapshot().selectedChatId).toBe("chat-b");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Chat B message"]);
});

// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
it('Chat switch survives a background refresh of the old chat', async () => {
  const chatBReleases: Array<(res: Response) => void> = [];
  const releaseChatB = () => {
    for (const release of chatBReleases.splice(0)) {
      release(Response.json({ messages: [chatMessage("msg-b1", "Chat B message")] }));
    }
  };
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: true,
        viewer: { accountId: "acc-me", handle: "me", displayName: "Me" },
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/chats/chat-a/messages") {
      return json({ messages: [chatMessage("msg-a1", "Chat A message")] });
    }
    if (path === "/api/chats/chat-b/messages") {
      return new Promise<Response>((resolve) => {
        chatBReleases.push(resolve);
      });
    }
    if (path === "/api/chats") {
      return json({
        chats: [
          { id: "chat-a", title: "Chat A", kind: "direct" },
          { id: "chat-b", title: "Chat B", kind: "direct" },
        ],
      });
    }
    if (path === "/api/chats/alpha-invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ notifications: [] });
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], replies: [] });
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);
  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
  await act(() => hydrateAuth());
  expect(getStoreSnapshot().viewer?.accountId).toBe("acc-me");

  await act(() => storeActions.selectChat("chat-a"));
  await act(() => storeActions.navigate("/chats"));
  await expect.element(page.getByRole("heading", { name: "Chat A" })).toBeInTheDocument();
  await expect.element(page.getByText("Chat A message")).toBeInTheDocument();
  expect(getStoreSnapshot().selectedChatId).toBe("chat-a");

  await act(() => userEvent.click(page.getByRole("button", { name: /Chat B/ })));
  expect(getStoreSnapshot().selectedChatId).toBe("chat-b");

  const refreshing = storeActions.loadChats();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  releaseChatB();
  await act(() => refreshing);

  await expect.element(page.getByRole("heading", { name: "Chat B" })).toBeInTheDocument();
  await expect.element(page.getByText("Chat B message")).toBeInTheDocument();
  await expect.element(page.getByText("Chat A message")).not.toBeInTheDocument();
  expect(getStoreSnapshot().selectedChatId).toBe("chat-b");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Chat B message"]);

  await act(() => storeActions.loadChatMessages("chat-a"));
  await expect.element(page.getByRole("heading", { name: "Chat B" })).toBeInTheDocument();
  await expect.element(page.getByText("Chat A message")).not.toBeInTheDocument();
  expect(getStoreSnapshot().selectedChatId).toBe("chat-b");
  expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Chat B message"]);
});
