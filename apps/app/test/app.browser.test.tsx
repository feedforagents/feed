// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"; spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"; spec/auth/email.md, "Story: Request and consume a single-use email magic link safely"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";

const opened: Root[] = [];
const predictionBuyBodies: string[] = [];
const createdEventSources: Array<EventTarget> = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
const liveEventSources: EventTarget[] = [];
let profileShouldFail = false;
let profileShould404 = false;

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
    marketBadge: {
      kind: "prediction",
      marketId: "seed-market-1",
      ticker: "",
      label: "Will OpenAGI ship Strawberry-9000 before Friday?",
      question: "Will OpenAGI ship Strawberry-9000 before Friday?",
      yesPct: 62,
      status: "active",
      resolvedOutcome: null,
      closesAt: "4h left",
      yesShares: 6200,
      noShares: 3800,
      volumePts: 420,
      sparkline: [
        { time: Date.now() - 3_600_000, yesProbability: 0.54 },
        { time: Date.now() - 1_800_000, yesProbability: 0.58 },
        { time: Date.now(), yesProbability: 0.62 },
      ],
    },
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

const SEED_MARKET_1 = {
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
};

const SEED_MARKET_2 = {
  ...SEED_MARKET_1,
  id: "seed-market-2",
  slotIndex: 1,
  question: "Will the city marathon break its course record this year?",
  category: "sports",
};

const SAMPLE_MARKETS = {
  predictions: [SEED_MARKET_1, SEED_MARKET_2],
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
  isFollowing: false,
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
      isFollowing: false,
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

const SAMPLE_TRADES = [
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
];

function profilePayload(id: string, handle: string, displayName: string) {
  return {
    profile: { id, handle, displayName, kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts: [],
    positions: {},
    nextCursor: null,
  };
}

function replyItem(id: string, authorId: string, authorHandle: string, authorDisplayName: string, content: string) {
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

function installMockNetwork(
  options: {
    holdHistoryRange?: string;
    holdTradesFor?: string;
    holdLikesFor?: string;
    holdArticleId?: string;
    holdLeaderboardScope?: string;
    holdPnlRange?: string;
    holdProfileReplies?: boolean;
    readonly perps?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) {
  const heldHistory = new Map<string, Array<() => void>>();
  const requestedHistoryRanges = new Set<string>();
  const heldMarkets: Array<() => void> = [];
  let marketsHeld = false;
  let marketsRequestedCount = 0;
  const heldTrades = new Map<string, Array<(items: unknown[]) => void>>();
  const requestedTrades = new Set<string>();
  const heldLikes = new Map<string, Array<(items: unknown[]) => void>>();
  const requestedLikes = new Set<string>();
  const heldArticles = new Map<string, Array<() => void>>();
  const requestedArticleIds = new Set<string>();
  const heldLeaderboard = new Map<string, Array<() => void>>();
  const requestedLeaderboardScopes = new Set<string>();
  const heldPnl = new Map<string, Array<() => void>>();
  const requestedPnlRanges = new Set<string>();
  const heldReplies = new Map<string, Array<(res: Response) => void>>();
  const requestedReplies = new Set<string>();
  profileShouldFail = false;
  profileShould404 = false;
  let signedIn = false;
  let uiMode: "game" | "social" = "game";
  let viewerHandle = "alice";
  let viewerDisplayName = "Alice Trader";
  let viewerEmailMasked: string | null = null;
  let viewerPhoneLast2: string | null = "01";
  let viewerBalanceCents = 10500;
  let viewerIsReviewer = true;
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/auth/logout") {
      signedIn = false;
      return json({ ok: true });
    }
    if (path === "/api/auth/reviewer/login") {
      signedIn = true;
      viewerHandle = "alice";
      viewerDisplayName = "Alice Trader";
      viewerPhoneLast2 = "01";
      viewerEmailMasked = null;
      viewerBalanceCents = 10500;
      viewerIsReviewer = true;
      return json({ ok: true });
    }
    if (path === "/api/auth/email/start") {
      return json({
        ok: true,
        emailMasked: "e***@example.com",
        expiresAtMs: Date.now() + 900_000,
        resendAvailableAtMs: Date.now() + 30_000,
        devMagicLinkUrl: `${window.location.origin}/auth/email?token=dev-email-token-1`,
      });
    }
    if (path === "/api/auth/email/verify") {
      return json({
        status: "needs_onboarding",
        onboardingToken: "email-onboard-jwt-1",
        emailMasked: "e***@example.com",
        redirectTo: "/",
      });
    }
    if (path === "/api/auth/email/onboard") {
      const bodyObj = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const nextHandle = typeof bodyObj.username === "string" && bodyObj.username ? bodyObj.username : "erin_trader";
      signedIn = true;
      viewerHandle = nextHandle;
      viewerDisplayName = typeof bodyObj.displayName === "string" && bodyObj.displayName ? bodyObj.displayName : nextHandle;
      viewerEmailMasked = "e***@example.com";
      viewerPhoneLast2 = null;
      viewerBalanceCents = 10000;
      viewerIsReviewer = false;
      return json({
        ok: true,
        account: {
          accountId: "acct-email-1",
          handle: viewerHandle,
          displayName: viewerDisplayName,
          emailMasked: viewerEmailMasked,
          balanceCents: viewerBalanceCents,
        },
      });
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
        emailAuthEnabled: true,
        devEmailLinkEnabled: true,
        viewer: signedIn
          ? {
              accountId: viewerIsReviewer ? "acct-player-1" : "acct-email-1",
              handle: viewerHandle,
              displayName: viewerDisplayName,
              bio: "Trading with 100 pts",
              avatarUrl: null,
              bannerUrl: null,
              phoneLast2: viewerPhoneLast2,
              phoneVerifiedAt: viewerPhoneLast2 ? Date.now() - 60_000 : null,
              emailMasked: viewerEmailMasked,
              emailVerifiedAt: viewerEmailMasked ? Date.now() - 60_000 : null,
              uiMode,
              balanceCents: viewerBalanceCents,
              startingGrantCents: 10000,
              isAdmin: false,
              isReviewer: viewerIsReviewer,
              agentGrant: null,
            }
          : null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
        devSmsCodeEnabled: true,
      });
    }
    if (path === "/api/users/alice") return json(profilePayload("acc-alice", "alice", "Alice Aardvark"));
    if (path === "/api/users/bob") return json(profilePayload("acc-bob", "bob", "Bob Badger"));
    if (options.holdProfileReplies && path === "/api/posts" && url.searchParams.get("filter") === "replies") {
      const handle = url.searchParams.get("authorHandle") ?? "";
      requestedReplies.add(handle);
      return new Promise<Response>((resolve) => {
        const pending = heldReplies.get(handle) ?? [];
        pending.push(resolve);
        heldReplies.set(handle, pending);
      });
    }
    if (path === "/api/feed" || path === "/api/posts") return json({ items: SAMPLE_POSTS, nextCursor: null });
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], ancestors: [], replies: [] });
    if (path === "/api/trending") return json({ trending: [] });
    if (path === "/api/articles") return json({ articles: [] });
    if (path.startsWith("/api/articles/")) {
      const id = decodeURIComponent(path.slice("/api/articles/".length));
      const body = { id, title: `Article ${id}`, summary: `Summary of ${id}`, body: `Body of ${id}`, publishedAt: Date.now() - 60_000 };
      if (options.holdArticleId === id) {
        requestedArticleIds.add(id);
        return new Promise<Response>((resolve) => {
          const pending = heldArticles.get(id) ?? [];
          pending.push(() => resolve(Response.json(body)));
          heldArticles.set(id, pending);
        });
      }
      return json(body);
    }
    if (path === "/api/markets") {
      marketsRequestedCount += 1;
      const body = signedIn ? SAMPLE_MARKETS : { predictions: SAMPLE_MARKETS.predictions, perps: options.perps ?? [] };
      if (marketsHeld) {
        return new Promise<Response>((resolve) => {
          heldMarkets.push(() => resolve(Response.json(body)));
        });
      }
      return json(body);
    }
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
      const range = url.searchParams.get("range") ?? "1D";
      const marketId = path.split("/")[4] ?? "";
      const finalPriceCents = marketId === "seed-market-2" ? 3333 : range === "1D" ? 1111 : range === "1W" ? 2222 : 50;
      const body = {
        range,
        points: [
          { timestamp: Date.now() - 3_600_000, recordedAt: Date.now() - 3_600_000, priceCents: 46, yesPriceBps: 4600, volumeCents: 1000 },
          { timestamp: Date.now(), recordedAt: Date.now(), priceCents: finalPriceCents, yesPriceBps: 5000, volumeCents: 2500 },
        ],
      };
      if (options.holdHistoryRange === range) {
        requestedHistoryRanges.add(range);
        return new Promise<Response>((resolve) => {
          const pending = heldHistory.get(range) ?? [];
          pending.push(() => resolve(Response.json(body)));
          heldHistory.set(range, pending);
        });
      }
      return json(body);
    }
    if (path.endsWith("/likes")) {
      const handle = decodeURIComponent(path.slice("/api/users/".length, path.length - "/likes".length));
      if (options.holdLikesFor === handle) {
        requestedLikes.add(handle);
        return new Promise<Response>((resolve) => {
          const pending = heldLikes.get(handle) ?? [];
          pending.push((items) => resolve(Response.json({ posts: items, nextCursor: null })));
          heldLikes.set(handle, pending);
        });
      }
      return json({ posts: SAMPLE_POSTS, nextCursor: null });
    }
    if (path.endsWith("/trades")) {
      if (path.startsWith("/api/users/")) {
        const handle = decodeURIComponent(path.slice("/api/users/".length, path.length - "/trades".length));
        if (options.holdTradesFor === handle) {
          requestedTrades.add(handle);
          return new Promise<Response>((resolve) => {
            const pending = heldTrades.get(handle) ?? [];
            pending.push((items) => resolve(Response.json({ trades: items })));
            heldTrades.set(handle, pending);
          });
        }
      }
      return json({ trades: SAMPLE_TRADES });
    }
    if (path === "/api/users/alice") return json(profilePayload("acc-alice", "alice", "Alice Aardvark"));
    if (path === "/api/users/bob") return json(profilePayload("acc-bob", "bob", "Bob Badger"));
    if (path.startsWith("/api/users/")) {
      const handle = decodeURIComponent(path.slice("/api/users/".length));
      return json({
        profile: {
          id: handle === viewerHandle ? (viewerIsReviewer ? "acct-player-1" : "acct-email-1") : "ailon-musk",
          kind: handle === viewerHandle ? "user" : "npc",
          handle,
          displayName: handle === viewerHandle ? viewerDisplayName : "AIlon Musk",
          bio: "Trading live on Feed",
          followersCount: 12,
          followingCount: 4,
          postsCount: 1,
          isParody: handle !== viewerHandle,
          viewerFollows: false,
          balanceCents: viewerBalanceCents,
        },
        posts: SAMPLE_POSTS,
        nextCursor: null,
        positions: SAMPLE_MARKETS.positions,
      });
    }
    if (path === "/api/markets/positions/closed") return json({ accountId: "acct-player-1", items: [], predictionPositions: [], perpPositions: [] });
    if (path === "/api/economy/me/pnl-history") {
      const range = url.searchParams.get("range") ?? "ALL";
      const finalPnlCents = range === "1D" ? 11_100 : range === "1W" ? 22_200 : 1528;
      const body = {
        range,
        points: [
          { timestamp: Date.now() - 3_600_000, pnlCents: 0, cumulativePnlCents: 0, deltaCents: 0, kind: "baseline" },
          { timestamp: Date.now(), pnlCents: finalPnlCents, cumulativePnlCents: finalPnlCents, deltaCents: finalPnlCents, kind: "mark_to_market" },
        ],
        currentNetProfitCents: finalPnlCents,
      };
      if (options.holdPnlRange === range) {
        requestedPnlRanges.add(range);
        return new Promise<Response>((resolve) => {
          const pending = heldPnl.get(range) ?? [];
          pending.push(() => resolve(Response.json(body)));
          heldPnl.set(range, pending);
        });
      }
      return json(body);
    }
    if (path === "/api/economy/me") {
      return json({
        economy: {
          accountId: viewerIsReviewer ? "acct-player-1" : "acct-email-1",
          balanceCents: viewerBalanceCents,
          positionValueCents: viewerIsReviewer ? 1028 : 0,
          equityCents: viewerIsReviewer ? 11528 : viewerBalanceCents,
          startingGrantCents: 10000,
          totalFeesPaidCents: 10,
          netProfitCents: viewerIsReviewer ? 1528 : 0,
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
      const isChars = url.searchParams.get("scope") === "characters" || url.searchParams.get("filter") === "npcs";
      const scope = isChars ? "characters" : "players";
      const body = isChars ? SAMPLE_LEADERBOARD_CHARACTERS : SAMPLE_LEADERBOARD_PLAYERS;
      if (options.holdLeaderboardScope === scope) {
        requestedLeaderboardScopes.add(scope);
        return new Promise<Response>((resolve) => {
          const pending = heldLeaderboard.get(scope) ?? [];
          pending.push(() => resolve(Response.json(body)));
          heldLeaderboard.set(scope, pending);
        });
      }
      return json(body);
    }
    if (path === "/api/leaderboard/me") {
      return json({ position: { rank: 1, page: 1, totalCount: 1, totalPages: 1, entry: SAMPLE_LEADERBOARD_PLAYERS.currentUser } });
    }
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ items: [], unreadCount: 0 });
    if (path.endsWith("/buy")) {
      predictionBuyBodies.push(typeof init?.body === "string" ? init.body : "");
      return json({ ok: true });
    }
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return json({ items: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    if (path === "/api/posts") return json({ items: [], nextCursor: null });
    if (path.startsWith("/api/users/")) {
      const userHandle = decodeURIComponent(path.slice("/api/users/".length));
      if (userHandle !== "ailonmusk") {
        if (profileShouldFail) {
          return Promise.resolve(new Response(JSON.stringify({ error: "http_503", code: "http_503", message: "Request failed (503)" }), { status: 503 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ error: "not_found", code: "not_found", message: "Profile not found." }), { status: 404 }));
      }
      if (profileShould404) {
        return Promise.resolve(new Response(JSON.stringify({ error: "not_found", code: "not_found", message: "Profile not found." }), { status: 404 }));
      }
      if (profileShouldFail) {
        return Promise.resolve(new Response(JSON.stringify({ error: "http_503", code: "http_503", message: "Request failed (503)" }), { status: 503 }));
      }
      return json({
        profile: {
          id: "ailonmusk",
          handle: "ailonmusk",
          displayName: "AIlon Musk",
          bio: "",
          isParody: true,
          followersCount: 10,
          followingCount: 5,
          postsCount: 1,
          viewerFollows: false,
          viewerMutes: false,
          viewerBlocks: false,
        },
        posts: SAMPLE_POSTS,
        nextCursor: null,
        positions: [],
      });
    }
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    constructor() {
      super();
      createdEventSources.push(this);
      liveEventSources.push(this);
    }
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);

  return {
    historyRequested: (range: string) => requestedHistoryRanges.has(range),
    releaseHistory: (range: string) => {
      for (const release of heldHistory.get(range)?.splice(0) ?? []) release();
    },
    holdMarkets: () => {
      marketsHeld = true;
    },
    releaseMarkets: () => {
      marketsHeld = false;
      for (const release of heldMarkets.splice(0)) release();
    },
    marketsRequestedCount: () => marketsRequestedCount,
    dispatchSse: (type: string, data: unknown) => {
      const source = createdEventSources.at(-1);
      if (!source) throw new Error("no EventSource created yet");
      source.dispatchEvent(new MessageEvent(type, { data }));
    },
    tradesRequested: (handle: string) => requestedTrades.has(handle),
    releaseTrades: (handle: string, items: unknown[]) => {
      for (const release of heldTrades.get(handle)?.splice(0) ?? []) release(items);
    },
    likesRequested: (handle: string) => requestedLikes.has(handle),
    releaseLikes: (handle: string, items: unknown[]) => {
      for (const release of heldLikes.get(handle)?.splice(0) ?? []) release(items);
    },
    articleRequested: (id: string) => requestedArticleIds.has(id),
    releaseArticle: (id: string) => {
      for (const release of heldArticles.get(id)?.splice(0) ?? []) release();
    },
    leaderboardRequested: (scope: string) => requestedLeaderboardScopes.has(scope),
    releaseLeaderboard: (scope: string) => {
      for (const release of heldLeaderboard.get(scope)?.splice(0) ?? []) release();
    },
    pnlRequested: (range: string) => requestedPnlRanges.has(range),
    releasePnl: (range: string) => {
      for (const release of heldPnl.get(range)?.splice(0) ?? []) release();
    },
    repliesRequested: (handle: string) => requestedReplies.has(handle),
    releaseReplies: (handle: string, items: unknown[]) => {
      for (const release of heldReplies.get(handle)?.splice(0) ?? []) {
        release(Response.json({ items, nextCursor: null }));
      }
    },
    releaseLatestReplies: (handle: string, items: unknown[]) => {
      heldReplies.get(handle)?.pop()?.(Response.json({ items, nextCursor: null }));
    },
  };
}

async function renderApp() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
}

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  await act(() => storeActions.logout());
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function mountApp(options?: Parameters<typeof installMockNetwork>[0]) {
  const network = installMockNetwork(options ?? {});
  await renderApp();
  return network;
}

async function mountAppAtHome(options?: Parameters<typeof installMockNetwork>[0]) {
  const network = await mountApp(options);
  await act(() => storeActions.navigate("/"));
  return network;
}

async function signInAsReviewer() {
  await act(() => userEvent.click(page.getByRole("button", { name: "Reviewer sign-in" })));
  await act(() => userEvent.fill(page.getByLabelText(/Reviewer username|Username/i), "alice"));
  await act(() => userEvent.fill(page.getByLabelText(/Password/i), "secret-pass"));
  await act(() => userEvent.click(page.getByRole("button", { name: /Sign in as reviewer/i })));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
}

it('Visitors browse feed, markets, leaderboard, sign in, and view profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await mountApp();

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByText("Prediction Market").first()).toBeInTheDocument();
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
  await expect.element(page.getByText("Alice Trader").first()).toBeInTheDocument();
  await expect.element(page.getByText("+15.3%").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "NPCs" })));
  await expect.element(page.getByText("AIlon Musk").first()).toBeInTheDocument();

  const modeSwitch = page.getByRole("switch", { name: "Social mode" }).first();
  await act(() => userEvent.click(modeSwitch));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Markets" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Leaderboard" })).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: /^Reply/ })));
  await expect.element(page.getByRole("main").getByRole("heading", { name: "Post", exact: true })).toBeInTheDocument();
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
  await expect.element(page.getByRole("tab", { name: "Email" })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Connect Agent" })).toBeInTheDocument();
  await signInAsReviewer();

  await act(() => storeActions.setPlayMode("game"));

  const walletButton = page.getByRole("button", { name: "Wallet" }).first();
  await act(() => userEvent.click(walletButton));
  await expect.element(page.getByText("Size 19.78 shares")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("1978 shares");
  expect(document.body.textContent).not.toMatch(/Buy pts|Stripe/i);
  await expect.element(page.getByText("Starting Grant")).toBeInTheDocument();

  await act(() => storeActions.navigate("/u/alice"));
  await act(() => userEvent.click(page.getByRole("tab", { name: "Likes" })));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Trades" })));
  await expect.element(page.getByText("BUY YES").first()).toBeInTheDocument();
});

it('Quick-trade BUY NO on a feed market card opens the ticket on NO (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
  await mountAppAtHome();

  await expect.element(page.getByText("Prediction Market").first()).toBeInTheDocument();

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await signInAsReviewer();
  await act(() => storeActions.navigate("/"));
  await act(() => userEvent.click(page.getByRole("button", { name: /BUY NO/ }).first()));

  await expect.element(page.getByRole("heading", { name: "Will OpenAGI ship Strawberry-9000 before Friday?" })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Buy NO" })).toBeInTheDocument();

  await act(() => storeActions.navigate("/markets/predictions/seed-market-1?side=yes"));
  await expect.element(page.getByRole("button", { name: "Buy YES" })).toBeInTheDocument();
  await act(() => storeActions.navigate("/markets/predictions/seed-market-1?side=no"));
  await expect.element(page.getByRole("button", { name: "Buy NO" })).toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: "Buy NO" })));
  await expect.element(page.getByText("Confirm Buy NO")).toBeInTheDocument();
  await act(() => storeActions.navigate("/markets/predictions/seed-market-1?side=yes"));
  await act(() => userEvent.click(page.getByRole("button", { name: "Confirm Trade" })));
  expect(predictionBuyBodies.at(-1)).toContain('"side":"no"');
});

it('Email Magic Link sign-in, onboarding, and Settings view (spec/auth/email.md, "Story: Request and consume a single-use email magic link safely")', async () => {
  await mountAppAtHome();

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await expect.element(page.getByRole("dialog", { name: "Join Feed" })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Email" })).toBeInTheDocument();

  await act(() => userEvent.fill(page.getByPlaceholder("you@example.com"), "erin@example.com"));
  await act(() => userEvent.click(page.getByRole("button", { name: /Send magic link/i })));

  await expect.element(page.getByText("e***@example.com")).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("button", { name: /Open dev magic link/i })));

  expect(window.location.pathname).toBe("/auth/email");
  expect(window.location.search).toBe("");
  await expect.element(page.getByText("Finish creating your Feed account")).toBeInTheDocument();

  await act(() => userEvent.fill(page.getByLabelText("Username"), "erin_trader"));
  await act(() => userEvent.click(page.getByLabelText(/at least 18 years old/i)));
  await act(() => userEvent.click(page.getByLabelText(/Terms of Service/i)));
  await act(() => userEvent.click(page.getByRole("button", { name: /Claim 100 pts & enter/i })));

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();

  await act(() => storeActions.navigate("/settings?tab=account"));
  await expect.element(page.getByText("e***@example.com")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Change email" })).toBeInTheDocument();
});

it('Stale market history is dropped after switching ranges (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
  const network = await mountApp({ holdHistoryRange: "1D" });

  act(() => {
    storeActions.selectMarket("prediction", "seed-market-1");
  });
  await act(() => Promise.resolve());
  expect(network.historyRequested("1D")).toBe(true);
  expect(getStoreSnapshot().marketTimeRange).toBe("1D");

  await act(() => storeActions.setMarketTimeRange("1W"));
  expect(getStoreSnapshot().marketTimeRange).toBe("1W");
  expect(getStoreSnapshot().marketHistory.at(-1)?.priceCents).toBe(2222);

  network.releaseHistory("1D");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().marketTimeRange).toBe("1W");
  expect(getStoreSnapshot().marketHistory.at(-1)?.priceCents).toBe(2222);
  expect(getStoreSnapshot().marketHistoryLoading).toBe(false);
});

it('Market refresh in flight loads the newly selected market (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
  const network = await mountApp({ holdHistoryRange: "1D" });

  await act(() => storeActions.navigate("/markets"));
  expect(getStoreSnapshot().route).toBe("Markets");
  await act(() => storeActions.setMarketTimeRange("1D"));

  act(() => {
    storeActions.selectMarket("prediction", "seed-market-1");
  });
  await act(() => Promise.resolve());
  expect(network.historyRequested("1D")).toBe(true);

  network.releaseHistory("1D");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().selectedMarketId).toBe("seed-market-1");
  expect(getStoreSnapshot().marketHistory.at(-1)?.priceCents).toBe(1111);
  expect(getStoreSnapshot().marketHistoryLoading).toBe(false);

  const marketsBefore = network.marketsRequestedCount();
  network.holdMarkets();
  act(() => {
    network.dispatchSse("world.tick", "{}");
  });
  await act(() => Promise.resolve());
  expect(network.marketsRequestedCount()).toBe(marketsBefore + 1);
  expect(getStoreSnapshot().selectedMarketId).toBe("seed-market-1");

  act(() => {
    storeActions.selectMarket("prediction", "seed-market-2");
  });
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().selectedMarketId).toBe("seed-market-2");
  expect(getStoreSnapshot().marketHistory).toEqual([]);
  expect(getStoreSnapshot().marketHistoryLoading).toBe(true);

  network.releaseMarkets();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().selectedMarketId).toBe("seed-market-2");

  network.releaseHistory("1D");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().marketHistory.at(-1)?.priceCents).toBe(3333);
  expect(getStoreSnapshot().marketHistoryLoading).toBe(false);
});

it('Late trades never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdTradesFor: "alice" });

  await act(() => storeActions.navigate("/u/alice"));
  await expect.element(page.getByText("Alice Aardvark").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Trades" })));
  await act(() => Promise.resolve());
  expect(network.tradesRequested("alice")).toBe(true);

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(network.tradesRequested("bob")).toBe(false);

  network.releaseTrades("alice", [{ ...SAMPLE_TRADES[0], id: "alice-trade-1" }]);
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileTrades).toEqual([]);
  expect(getStoreSnapshot().profileTradesLoading).toBe(false);

  await act(() => userEvent.click(page.getByRole("tab", { name: "Posts" })));
  await act(() => userEvent.click(page.getByRole("tab", { name: "Trades" })));
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileTrades.map((t) => t.id)).toEqual(["trade-1"]);
});

it('Late likes never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdLikesFor: "alice" });

  await act(() => storeActions.navigate("/u/alice"));
  await expect.element(page.getByText("Alice Aardvark").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Likes" })));
  await act(() => Promise.resolve());
  expect(network.likesRequested("alice")).toBe(true);

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(network.likesRequested("bob")).toBe(false);

  network.releaseLikes("alice", [
    {
      ...SAMPLE_POSTS[0],
      id: "alice-like-1",
      content: "Stale liked post from Alice profile",
    },
  ]);
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileLikes).toEqual([]);
  expect(getStoreSnapshot().profileLikesLoading).toBe(false);
  await expect.element(page.getByText("Stale liked post from Alice profile")).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("tab", { name: "Posts" })));
  await act(() => userEvent.click(page.getByRole("tab", { name: "Likes" })));
  await act(() => Promise.resolve());
  expect(network.likesRequested("bob")).toBe(false);
  expect(getStoreSnapshot().profileLikes.map((p) => p.card.id)).toEqual(["browser-post-1"]);
});

it('Stale article is dropped after opening another article (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdArticleId: "article-a" });

  act(() => {
    void storeActions.loadArticle("article-a");
  });
  await act(() => Promise.resolve());
  expect(network.articleRequested("article-a")).toBe(true);
  expect(getStoreSnapshot().activeArticleId).toBe("article-a");

  await act(() => storeActions.loadArticle("article-b"));
  expect(getStoreSnapshot().activeArticleId).toBe("article-b");
  expect(getStoreSnapshot().activeArticle?.id).toBe("article-b");

  network.releaseArticle("article-a");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().activeArticleId).toBe("article-b");
  expect(getStoreSnapshot().activeArticle?.id).toBe("article-b");
  expect(getStoreSnapshot().articleLoading).toBe(false);
});

it('Stale leaderboard is dropped after switching filters (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
  const network = await mountApp({ holdLeaderboardScope: "players" });

  act(() => {
    void storeActions.loadLeaderboard({ scope: "players" });
  });
  await act(() => Promise.resolve());
  expect(network.leaderboardRequested("players")).toBe(true);

  await act(() => storeActions.loadLeaderboard({ scope: "characters" }));
  expect(getStoreSnapshot().leaderboardScope).toBe("characters");
  expect(getStoreSnapshot().leaderboard[0]?.handle).toBe("ailonmusk");

  network.releaseLeaderboard("players");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().leaderboardScope).toBe("characters");
  expect(getStoreSnapshot().leaderboard[0]?.handle).toBe("ailonmusk");
  expect(getStoreSnapshot().leaderboardLoading).toBe(false);
});

it('Stale PnL history is dropped after switching ranges (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
  const network = await mountApp({ holdPnlRange: "1D" });

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await signInAsReviewer();

  act(() => {
    void storeActions.loadPnlHistory("1D");
  });
  await act(() => Promise.resolve());
  expect(network.pnlRequested("1D")).toBe(true);

  await act(() => storeActions.loadPnlHistory("1W"));
  expect(getStoreSnapshot().pnlTimeRange).toBe("1W");
  expect(getStoreSnapshot().pnlHistory.at(-1)?.value).toBe(222);

  network.releasePnl("1D");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().pnlTimeRange).toBe("1W");
  expect(getStoreSnapshot().pnlHistory.at(-1)?.value).toBe(222);
  expect(getStoreSnapshot().pnlHistoryLoading).toBe(false);
});

it('Late replies never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdProfileReplies: true });
  const openRepliesTab = async () => {
    await act(() => userEvent.click(page.getByRole("tab", { name: "Posts" })));
    await act(() => userEvent.click(page.getByRole("tab", { name: "Replies" })));
    await act(() => Promise.resolve());
  };

  await act(() => storeActions.navigate("/u/alice"));
  await expect.element(page.getByText("Alice Aardvark").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Replies" })));
  await act(() => Promise.resolve());
  expect(network.repliesRequested("alice")).toBe(true);

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(network.repliesRequested("bob")).toBe(false);

  network.releaseReplies("alice", [replyItem("alice-reply-1", "acc-alice", "alice", "Alice Aardvark", "Alice reply that must not land on Bob")]);
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileReplies).toEqual([]);
  expect(getStoreSnapshot().profileRepliesLoading).toBe(false);
  await expect.element(page.getByText("Alice reply that must not land on Bob")).not.toBeInTheDocument();

  await openRepliesTab();
  expect(network.repliesRequested("bob")).toBe(true);
  network.releaseReplies("bob", [replyItem("bob-reply-1", "acc-bob", "bob", "Bob Badger", "Bob reply on Bob profile")]);
  await expect.element(page.getByText("Bob reply on Bob profile")).toBeInTheDocument();
  expect(getStoreSnapshot().profileReplies.map((p) => p.card.authorHandle)).toEqual(["bob"]);

  await openRepliesTab();
  await openRepliesTab();
  network.releaseLatestReplies("bob", [replyItem("bob-reply-2", "acc-bob", "bob", "Bob Badger", "Newer Bob reply")]);
  await expect.element(page.getByText("Newer Bob reply")).toBeInTheDocument();
  network.releaseReplies("bob", [replyItem("bob-reply-stale", "acc-bob", "bob", "Bob Badger", "Stale Bob reply must not replace newer")]);
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileReplies.map((p) => p.card.id)).toEqual(["bob-reply-2"]);
  await expect.element(page.getByText("Stale Bob reply must not replace newer")).not.toBeInTheDocument();
  await expect.element(page.getByText("Newer Bob reply")).toBeInTheDocument();
});

function r37ProfilePayload(id: string, handle: string, displayName: string) {
  return {
    profile: { id, handle, displayName, kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts: [],
    positions: {},
    nextCursor: null,
  };
}

it('Switching profiles never shows the previous profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  let bobRequested = false;
  let bobHeld = true;
  const bobReleases: Array<(res: Response) => void> = [];
  const releaseBob = () => {
    for (const release of bobReleases.splice(0)) release(Response.json(r37ProfilePayload("acc-bob", "bob", "Bob Badger")));
  };
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({ authenticated: false, viewer: null, acceptedCountries: ["+1", "+44"], publicAppUrl: window.location.origin });
    }
    if (path === "/api/users/alice") return json(r37ProfilePayload("acc-alice", "alice", "Alice Aardvark"));
    if (path === "/api/users/bob" || path === "/api/users/acc-bob") {
      bobRequested = true;
      if (bobHeld) {
        return new Promise<Response>((resolve) => {
          bobReleases.push(resolve);
        });
      }
      return json(r37ProfilePayload("acc-bob", "bob", "Bob Badger"));
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
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("alice");

  const navBob = storeActions.navigate("/u/bob");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(bobRequested).toBe(true);
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(getStoreSnapshot().profileBundle?.summary.handle).not.toBe("alice");
  await expect.element(page.getByText("Alice Aardvark")).not.toBeInTheDocument();

  bobHeld = false;
  releaseBob();
  await act(() => navBob);
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");

  bobHeld = true;
  bobRequested = false;
  const refreshBob = storeActions.loadProfile();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(bobRequested).toBe(true);
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  bobHeld = false;
  releaseBob();
  await act(() => refreshBob);
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");
});

it('A failed profile refetch keeps the open profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await expect.element(page.getByText("1 post")).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");

  profileShouldFail = true;
  liveEventSources[0].dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => expect(getStoreSnapshot().profileLoading).toBe(false));
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");
  expect(getStoreSnapshot().profileBundle?.posts.length).toBe(1);
  expect(getStoreSnapshot().errorMessage).not.toBeNull();
  await expect.element(page.getByText("Profile not found")).not.toBeInTheDocument();
  await expect.element(page.getByText("1 post")).toBeInTheDocument();

  profileShouldFail = false;
  await act(async () => {
    await storeActions.navigate("/u/ghost");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShouldFail = false;
  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk"));
  profileShouldFail = true;
  await act(async () => {
    await storeActions.navigate("/u/other");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShouldFail = false;

  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk"));
  profileShould404 = true;
  liveEventSources[0].dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShould404 = false;
});

it('Explore search "$PRED" lists the PRED org in the Orgs tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork({ perps: [{ ticker: "PRED", name: "Prediction" }] });
  setStoreState({
    viewer: null,
    localUiMode: "game",
    route: "Home",
    exploreQuery: "",
    activeTrendingTag: null,
    activeArticleId: null,
    perps: [],
    predictions: [],
  });
  await renderApp();

  await act(() => userEvent.click(page.getByRole("button", { name: "Explore" }).first()));
  const search = page.getByPlaceholder("Search posts, @people, #tags, or $tickers");
  await expect.element(search).toBeInTheDocument();
  await act(() => userEvent.fill(search, "$PRED"));
  await act(() => userEvent.click(page.getByRole("button", { name: "Search", exact: true })));
  await expect.element(page.getByRole("tab", { name: "Top" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Orgs" })));
  await expect.element(page.getByText("No matching organizations")).not.toBeInTheDocument();
  await expect.element(page.getByRole("main").getByText("Prediction")).toBeInTheDocument();
  await expect.element(page.getByText("Organization")).toBeInTheDocument();

  await act(() => userEvent.fill(search, "$"));
  await act(() => userEvent.click(page.getByRole("button", { name: "Search", exact: true })));
  await expect.element(page.getByRole("tab", { name: "Top" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Orgs" })));
  await expect.element(page.getByText("No matching organizations")).toBeInTheDocument();
  await expect.element(page.getByRole("main").getByText("Prediction")).not.toBeInTheDocument();
});
