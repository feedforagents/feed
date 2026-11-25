// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"; spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot } from "../src/web/store-core.ts";

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
      yesShares: 5000,
      noShares: 5000,
      liquidityCents: 100_000,
      yesPriceBps: 5000,
      noPriceBps: 5000,
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
  positions: {
    predictionPositions: [
      {
        marketId: "seed-market-1",
        question: "Will OpenAGI ship Strawberry-9000 before Friday?",
        marketStatus: "open",
        holderId: "acct-player-1",
        holderKind: "user",
        side: "yes",
        shares: 1978,
        costBasisCents: 1000,
        settledAt: null,
        payoutCents: 0,
        yesPriceBps: 5200,
        noPriceBps: 4800,
        estimatedValueCents: 1028,
      },
    ],
    perpPositions: [],
  },
};

const SAMPLE_LEADERBOARD_PLAYER_ENTRY = {
  rank: 1,
  accountId: "acct-player-1",
  handle: "alice",
  displayName: "Alice Trader",
  avatarUrl: null,
  isNpc: false,
  balanceCents: 10500,
  positionValueCents: 1028,
  equityCents: 11528,
  startingGrantCents: 10000,
  netProfitCents: 1528,
  returnBps: 1528,
  returnPct: 15.28,
  volumeCents: 2500,
  tradeCount: 3,
  wins: 2,
  settledCount: 2,
  winRate: 1,
  winRatePct: 100,
};

const SAMPLE_LEADERBOARD_PLAYERS = {
  scope: "players",
  metric: "net_profit",
  page: 1,
  pageSize: 25,
  totalCount: 1,
  totalPages: 1,
  currentUser: SAMPLE_LEADERBOARD_PLAYER_ENTRY,
  entries: [SAMPLE_LEADERBOARD_PLAYER_ENTRY],
};

const SAMPLE_LEADERBOARD_CHARACTERS = {
  scope: "characters",
  metric: "net_profit",
  page: 1,
  pageSize: 25,
  totalCount: 1,
  totalPages: 1,
  currentUser: null,
  entries: [
    {
      rank: 1,
      accountId: "ailon-musk",
      handle: "ailonmusk",
      displayName: "AIlon Musk",
      avatarUrl: null,
      isNpc: true,
      balanceCents: 10_000_000,
      positionValueCents: 0,
      equityCents: 10_000_000,
      startingGrantCents: 10_000_000,
      netProfitCents: 4200,
      returnBps: 42,
      returnPct: 0.42,
      volumeCents: 8000,
      tradeCount: 4,
      wins: 3,
      settledCount: 4,
      winRate: 0.75,
      winRatePct: 75,
    },
  ],
};

function installMockNetwork() {
  let signedIn = false;
  let uiMode: "game" | "social" = "game";
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/auth/reviewer/login") {
      signedIn = true;
      return json({ ok: true });
    }
    if (path === "/api/auth/mode") {
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      if (bodyStr.includes('"social"')) uiMode = "social";
      if (bodyStr.includes('"game"')) uiMode = "game";
      return json({ ok: true, uiMode });
    }
    if (path === "/api/auth/me") {
      return json({
        authenticated: signedIn,
        viewer: signedIn
          ? {
              accountId: "acct-player-1",
              handle: "alice",
              displayName: "Alice Trader",
              bio: "Trading with 100 pts",
              avatarUrl: null,
              bannerUrl: null,
              phoneLast2: "01",
              uiMode,
              balanceCents: 10500,
              startingGrantCents: 10000,
              isAdmin: false,
              isReviewer: true,
              agentGrant: null,
            }
          : null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
        devSmsCodeEnabled: true,
      });
    }
    if (path === "/api/feed" || path === "/api/posts") return json({ items: SAMPLE_POSTS, nextCursor: null });
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], ancestors: [], replies: [] });
    if (path === "/api/trending") return json({ trending: [] });
    if (path === "/api/articles") return json({ articles: [] });
    if (path === "/api/markets") return json(signedIn ? SAMPLE_MARKETS : { predictions: SAMPLE_MARKETS.predictions, perps: [] });
    if (path === "/api/world/status") {
      return json({
        currentDay: 3,
        currentHour: 14,
        phase: "active",
        gameRunning: true,
        lastTickAt: Date.now(),
        activeMarketsCount: 1,
        totalPostsCount: 1,
        activeActorsCount: 5,
      });
    }
    if (path.endsWith("/history")) {
      return json({
        range: "1D",
        points: [
          { timestamp: Date.now() - 3_600_000, recordedAt: Date.now() - 3_600_000, priceCents: 46, yesPriceBps: 4600, volumeCents: 1000 },
          { timestamp: Date.now(), recordedAt: Date.now(), priceCents: 50, yesPriceBps: 5000, volumeCents: 2500 },
        ],
      });
    }
    if (path.endsWith("/trades")) {
      return json({
        trades: [
          {
            id: "trade-1",
            traderId: "ailon-musk",
            traderName: "AIlon Musk",
            traderDisplayName: "AIlon Musk",
            traderHandle: "ailonmusk",
            traderAvatarUrl: null,
            isNpc: true,
            marketKind: "prediction",
            marketRef: "seed-market-1",
            side: "buy_yes",
            sharesOrSize: 2000,
            priceCents: 50,
            notionalCents: 1000,
            feeCents: 1,
            createdAt: Date.now() - 30_000,
          },
        ],
      });
    }
    if (path === "/api/markets/positions/closed") return json({ accountId: "acct-player-1", items: [], predictionPositions: [], perpPositions: [] });
    if (path === "/api/economy/me/pnl-history") {
      return json({
        range: "ALL",
        points: [
          { timestamp: Date.now() - 3_600_000, pnlCents: 0, cumulativePnlCents: 0, deltaCents: 0, kind: "baseline" },
          { timestamp: Date.now(), pnlCents: 1528, cumulativePnlCents: 1528, deltaCents: 1528, kind: "mark_to_market" },
        ],
        currentNetProfitCents: 1528,
      });
    }
    if (path === "/api/economy/me") {
      return json({
        economy: {
          accountId: "acct-player-1",
          balanceCents: 10500,
          positionValueCents: 1028,
          equityCents: 11528,
          startingGrantCents: 10000,
          totalFeesPaidCents: 10,
          netProfitCents: 1528,
        },
        ledger: [
          {
            id: "led-1",
            kind: "starting_grant",
            deltaCents: 10000,
            balanceAfterCents: 10000,
            refId: null,
            createdAt: Date.now() - 3_600_000,
          },
        ],
      });
    }
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], actors: [], organizations: [], tags: [] } });
    if (path === "/api/leaderboard") {
      return json(url.searchParams.get("scope") === "characters" ? SAMPLE_LEADERBOARD_CHARACTERS : SAMPLE_LEADERBOARD_PLAYERS);
    }
    if (path === "/api/leaderboard/me") {
      return json({ position: { rank: 1, page: 1, totalCount: 1, totalPages: 1, entry: SAMPLE_LEADERBOARD_PLAYERS.currentUser } });
    }
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ items: [], unreadCount: 0 });
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return json({ items: [] });
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

it('Visitors browse markets and leaderboard, switch modes, sign in, and view fixed 100 pts wallet (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await act(() => userEvent.click(page.getByRole("tab", { name: "For You" })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  const marketsButton = page.getByRole("button", { name: "Markets" }).first();
  await act(() => userEvent.click(marketsButton));
  await expect.element(page.getByText("Day 3")).toBeInTheDocument();
  const marketRowButton = page.getByRole("button", { name: /^Will OpenAGI ship Strawberry-9000 before Friday\?/ }).first();
  await expect.element(marketRowButton).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Buy pts|Stripe/i);
  await act(() => userEvent.click(marketRowButton));
  await expect.element(page.getByRole("heading", { name: "Will OpenAGI ship Strawberry-9000 before Friday?" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("button", { name: "Open trading tutorial" }).first()));
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Close" })));
  await expect.element(page.getByRole("tab", { name: "Trades (1)" })).toBeInTheDocument();

  const leaderboardButton = page.getByRole("button", { name: "Leaderboard" }).first();
  await act(() => userEvent.click(leaderboardButton));
  await expect.element(page.getByText("Alice Trader")).toBeInTheDocument();
  await expect.element(page.getByText("+15.3%")).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("radio", { name: "Characters" })));
  await expect.element(page.getByText("AIlon Musk")).toBeInTheDocument();

  const modeSwitch = page.getByRole("switch", { name: "Social mode" }).first();
  await act(() => userEvent.click(modeSwitch));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Markets" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Leaderboard" })).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: /^Reply/ })));
  await expect.element(page.getByRole("heading", { name: "Post", exact: true })).toBeInTheDocument();
  const reply = page.getByRole("textbox", { name: "Post text" });
  await act(() => userEvent.fill(reply, "Draft reply"));
  await act(() => userEvent.click(page.getByRole("button", { name: /^Like/ })));
  const join = page.getByRole("dialog", { name: "Join Feed" });
  await expect.element(join).toBeInTheDocument();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(() => userEvent.click(join.getByRole("button", { name: "Close" })));
  await expect.element(reply).toHaveValue("Draft reply");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Connect Agent" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("button", { name: "Reviewer sign-in" })));
  await act(() => userEvent.fill(page.getByLabelText(/Reviewer username|Username/i), "alice"));
  await act(() => userEvent.fill(page.getByLabelText(/Password/i), "secret-pass"));
  await act(() => userEvent.click(page.getByRole("button", { name: /Sign in as reviewer/i })));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  const walletButton = page.getByRole("button", { name: "Wallet" }).first();
  await act(() => userEvent.click(walletButton));
  await expect.element(page.getByText("Size 19.78 shares")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("1978 shares");
  expect(document.body.textContent).not.toMatch(/Buy pts|Stripe/i);
  await expect.element(page.getByText("Starting Grant")).toBeInTheDocument();
});

function r38ProfilePayload(id: string, handle: string, displayName: string) {
  return {
    profile: { id, handle, displayName, kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts: [],
    positions: {},
    nextCursor: null,
  };
}

function r38ReplyItem(id: string, authorId: string, authorHandle: string, authorDisplayName: string, content: string) {
  return {
    id,
    authorId,
    authorKind: "user",
    authorHandle,
    authorDisplayName,
    avatarUrl: null,
    content,
    replyToPostId: "parent-post-1",
    quotePostId: null,
    viaClientName: null,
    marketId: null,
    ticker: null,
    cashtags: [],
    hashtags: [],
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt: Date.now() - 60_000,
  };
}

it('Late replies never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  let aliceRepliesRequested = false;
  let bobRepliesRequested = false;
  const aliceReleases: Array<(res: Response) => void> = [];
  const bobReleases: Array<(res: Response) => void> = [];
  const releaseAliceReplies = () => {
    for (const release of aliceReleases.splice(0)) {
      release(Response.json({ items: [r38ReplyItem("alice-reply-1", "acc-alice", "alice", "Alice Aardvark", "Alice reply that must not land on Bob")], nextCursor: null }));
    }
  };
  const releaseBobReplies = () => {
    for (const release of bobReleases.splice(0)) {
      release(Response.json({ items: [r38ReplyItem("bob-reply-1", "acc-bob", "bob", "Bob Badger", "Bob reply on Bob profile")], nextCursor: null }));
    }
  };
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return json({ authenticated: false, viewer: null, acceptedCountries: ["+1", "+44"], publicAppUrl: window.location.origin });
    }
    if (path === "/api/users/alice") return json(r38ProfilePayload("acc-alice", "alice", "Alice Aardvark"));
    if (path === "/api/users/bob") return json(r38ProfilePayload("acc-bob", "bob", "Bob Badger"));
    if (path === "/api/posts" && url.searchParams.get("filter") === "replies") {
      if (url.searchParams.get("authorHandle") === "alice") {
        aliceRepliesRequested = true;
        return new Promise<Response>((resolve) => {
          aliceReleases.push(resolve);
        });
      }
      bobRepliesRequested = true;
      return new Promise<Response>((resolve) => {
        bobReleases.push(resolve);
      });
    }
    if (path === "/api/feed" || path === "/api/posts") return json({ items: SAMPLE_POSTS, nextCursor: null });
    if (path === "/api/markets") return json({ predictions: SAMPLE_MARKETS.predictions, perps: [] });
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], actors: [], organizations: [], tags: [] } });
    if (path === "/api/leaderboard") return json(SAMPLE_LEADERBOARD_PLAYERS);
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

  await act(() => storeActions.navigate("/u/alice"));
  await expect.element(page.getByText("Alice Aardvark").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Replies" })));
  await act(() => Promise.resolve());
  expect(aliceRepliesRequested).toBe(true);

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");

  await act(() => userEvent.click(page.getByRole("tab", { name: "Posts" })));
  await act(() => userEvent.click(page.getByRole("tab", { name: "Replies" })));
  await act(() => Promise.resolve());
  expect(bobRepliesRequested).toBe(true);

  releaseBobReplies();
  await expect.element(page.getByText("Bob reply on Bob profile")).toBeInTheDocument();
  expect(getStoreSnapshot().profileReplies.map((p) => p.card.authorHandle)).toEqual(["bob"]);

  releaseAliceReplies();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileReplies.map((p) => p.card.authorHandle)).toEqual(["bob"]);
  await expect.element(page.getByText("Alice reply that must not land on Bob")).not.toBeInTheDocument();
  await expect.element(page.getByText("Bob reply on Bob profile")).toBeInTheDocument();
});
