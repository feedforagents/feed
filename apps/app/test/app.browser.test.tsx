// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"; spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"; spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"; spec/auth/email.md, "Story: Request and consume a single-use email magic link safely"
import { act } from "react";
import { type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { reconnectRealtime, storeActions } from "../src/web/store.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { hydrateAuth } from "../src/web/store-auth.ts";
import {
  installAppTestLifecycle,
  installStubEventSource,
  makeViewerSession,
  mountApp as mountAppRoot,
  requestUrl,
} from "./app-test-helpers.tsx";

const opened: Root[] = [];
const predictionBuyBodies: string[] = [];
const phoneStartRequests: Array<Record<string, unknown>> = [];
const createdEventSources: Array<EventTarget> = [];
const liveEventSources: EventTarget[] = [];
let profileShouldFail = false;
let profileShould404 = false;
let explorePosts: typeof SAMPLE_POSTS = [];
const fetchPaths: string[] = [];
const POST_DELETED_VIEWER = makeViewerSession({
  accountId: "ailon-musk",
  handle: "ailonmusk",
  displayName: "AIlon Musk",
});

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
        grossEstimatedValueCents: 1030,
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

function makePostRecord(overrides: Record<string, unknown>) {
  return {
    id: "post-1",
    authorId: "acc-bob",
    authorKind: "user",
    authorHandle: "bob",
    authorDisplayName: "Bob Badger",
    avatarUrl: null,
    content: "",
    replyToPostId: null,
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
    ...overrides,
  };
}

function replyItem(id: string, authorId: string, authorHandle: string, authorDisplayName: string, content: string) {
  return makePostRecord({
    id,
    authorId,
    authorHandle,
    authorDisplayName,
    content,
    replyToPostId: "parent-post-1",
  });
}

function installMockNetwork(
  options: {
    holdHistoryRange?: string;
    holdTradesFor?: string;
    holdLikesFor?: string;
    holdArticleId?: string;
    holdLeaderboardScope?: string;
    holdPnlRange?: string;
    holdClosedPositionsFirst?: boolean;
    holdEconomyFirst?: boolean;
    holdProfileReplies?: boolean;
    readonly perps?: ReadonlyArray<Record<string, unknown>>;
    readonly threadFetch?: (path: string) => Promise<Response> | null;
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
  const heldClosedPositions: Array<() => void> = [];
  let closedPositionsCalls = 0;
  const heldEconomy: Array<() => void> = [];
  let economyCalls = 0;
  const heldReplies = new Map<string, Array<(res: Response) => void>>();
  const requestedReplies = new Set<string>();
  profileShouldFail = false;
  profileShould404 = false;
  explorePosts = [];
  fetchPaths.length = 0;
  let signedIn = false;
  let uiMode: "game" | "social" = "game";
  let viewerHandle = "alice";
  let viewerDisplayName = "Alice Trader";
  let viewerEmailMasked: string | null = null;
  let viewerPhoneLast2: string | null = "01";
  let viewerBalanceCents = 10500;
  let viewerIsReviewer = true;
  let feedFails = false;
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    const path = url.pathname;
    fetchPaths.push(path);
    const delayedThread = options.threadFetch?.(path) ?? null;
    if (delayedThread) return delayedThread;
    if (path === "/api/auth/phone/start") {
      try {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        phoneStartRequests.push(JSON.parse(rawBody) as Record<string, unknown>);
      } catch {
        phoneStartRequests.push({});
      }
      return json({});
    }
    if (path === "/api/auth/logout") {
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
    if (path === "/api/feed" && feedFails) return Promise.resolve(Response.json({ message: "Feed is unavailable." }, { status: 503 }));
    if (path === "/api/feed" && url.searchParams.get("tab") === "following") return json({ items: [{ ...SAMPLE_POSTS[0], id: "following-post-a" }], nextCursor: null });
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
      if (profileShouldFail) {
        return Promise.resolve(new Response(JSON.stringify({ error: "http_503", code: "http_503", message: "Request failed (503)" }), { status: 503 }));
      }
      if (profileShould404 || handle === "ghost") {
        return Promise.resolve(new Response(JSON.stringify({ error: "not_found", code: "not_found", message: "Profile not found." }), { status: 404 }));
      }
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
    if (path === "/api/markets/positions/closed") {
      closedPositionsCalls += 1;
      const callNo = closedPositionsCalls;
      const body = {
        accountId: "acct-player-1",
        items: [],
        predictionPositions: [],
        perpPositions:
          options.holdClosedPositionsFirst && callNo !== 1
            ? [
                {
                  id: "closed-perp-2",
                  ticker: "BTC",
                  side: "long",
                  marginCents: 10000,
                  realizedPnlCents: 22200,
                  closedAt: Date.now(),
                },
              ]
            : [],
      };
      if (options.holdClosedPositionsFirst && callNo === 1) {
        return new Promise<Response>((resolve) => {
          heldClosedPositions.push(() => resolve(Response.json(body)));
        });
      }
      return json(body);
    }
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
      economyCalls += 1;
      const fresh = options.holdEconomyFirst && economyCalls > 1;
      const body = {
        economy: {
          accountId: viewerIsReviewer ? "acct-player-1" : "acct-email-1",
          balanceCents: fresh ? 9900 : viewerBalanceCents,
          positionValueCents: viewerIsReviewer ? 1028 : 0,
          equityCents: fresh ? 10928 : viewerIsReviewer ? 11528 : viewerBalanceCents,
          startingGrantCents: 10000,
          totalFeesPaidCents: 10,
          netProfitCents: fresh ? 928 : viewerIsReviewer ? 1528 : 0,
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
      };
      if (options.holdEconomyFirst && economyCalls === 1) {
        return new Promise<Response>((resolve) => {
          heldEconomy.push(() => resolve(Response.json(body)));
        });
      }
      return json(body);
    }
    if (path === "/api/explore") {
      const query = url.searchParams.get("q") ?? "";
      return json({
        trending: [],
        articles: [],
        search: { posts: query === "" ? [] : explorePosts, accounts: [], actors: [], organizations: [], tags: [] },
      });
    }
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
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    constructor() {
      super();
      createdEventSources.push(this);
      liveEventSources.push(this);
    }
    close() {
      const idx = liveEventSources.indexOf(this);
      if (idx >= 0) liveEventSources.splice(idx, 1);
    }
  }
  vi.stubGlobal("EventSource", StubEventSource);
  reconnectRealtime();

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
    setFeedFails: (fails: boolean) => {
      feedFails = fails;
    },
    expireSession: () => {
      signedIn = false;
    },
    switchAccount: () => {
      viewerIsReviewer = false;
      viewerHandle = "erin_trader";
      viewerDisplayName = "Erin Trader";
    },
    pnlRequested: (range: string) => requestedPnlRanges.has(range),
    releasePnl: (range: string) => {
      for (const release of heldPnl.get(range)?.splice(0) ?? []) release();
    },
    closedPositionsRequested: () => closedPositionsCalls > 0,
    releaseClosedPositions: () => {
      for (const release of heldClosedPositions.splice(0)) release();
    },
    economyRequested: () => economyCalls > 0,
    releaseEconomy: () => {
      for (const release of heldEconomy.splice(0)) release();
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
  await mountAppRoot(opened);
}

installAppTestLifecycle(opened, async () => {
  storeActions.setJoinSheetOpen(false);
  await act(() => storeActions.logout());
});

async function mountCustomMockApp(options: {
  readonly authenticated?: boolean;
  readonly handle: (path: string, url: URL, init?: RequestInit) => Promise<Response> | undefined;
}) {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: options.authenticated ?? false,
        viewer: options.authenticated ? { accountId: "acc-me", handle: "me", displayName: "Me" } : null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    const custom = options.handle(path, url, init);
    if (custom !== undefined) return custom;
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
  installStubEventSource(liveEventSources);
  await renderApp();
  if (options.authenticated) {
    await act(() => hydrateAuth());
    expect(getStoreSnapshot().viewer?.accountId).toBe("acc-me");
  }
}

async function mountCustomHomeFeed(
  items: ReadonlyArray<unknown>,
  extra?: (path: string) => Promise<Response> | undefined,
) {
  await mountCustomMockApp({
    handle(path) {
      if (path === "/api/feed") return Promise.resolve(Response.json({ items, nextCursor: null }));
      if (path === "/api/markets") return Promise.resolve(Response.json({ predictions: [], perps: [] }));
      return extra?.(path);
    },
  });
  await act(() => userEvent.click(page.getByRole("button", { name: "Home", exact: true }).first()));
  return page.getByRole("main");
}

async function mountCustomExploreArticles(articles: ReadonlyArray<{ readonly id: string }>) {
  await mountCustomMockApp({
    handle(path) {
      if (path === "/api/explore" || path === "/api/articles") return Promise.resolve(Response.json({ articles }));
      const match = articles.find((article) => path === `/api/articles/${article.id}`);
      if (match) return Promise.resolve(Response.json(match));
      if (path === "/api/feed" || path === "/api/markets") return Promise.resolve(Response.json({ items: [], predictions: [], perps: [] }));
      return undefined;
    },
  });
  await act(() => userEvent.click(page.getByRole("button", { name: "Explore", exact: true }).first()));
  return page.getByRole("main");
}

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

async function mountSignedInApp(options?: Parameters<typeof installMockNetwork>[0]) {
  const network = await mountApp(options);
  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await signInAsReviewer();
  return network;
}

async function selectSeedMarket(network: Awaited<ReturnType<typeof mountApp>>) {
  act(() => {
    storeActions.selectMarket("prediction", "seed-market-1");
  });
  await act(() => Promise.resolve());
  expect(network.historyRequested("1D")).toBe(true);
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
  await act(() => userEvent.click(page.getByRole("button", { name: "Close" }).first()));
  await expect.element(page.getByText("Confirm Sell YES")).toBeInTheDocument();
  await expect.element(page.getByText("10.30 pts")).toBeInTheDocument();
  await expect.element(page.getByText("0.02 pts")).toBeInTheDocument();
  expect(document.body.textContent).toContain("Net Proceeds10.28 pts");
  expect(document.body.textContent).toContain("Est. PnL+0.28 pts");
  expect(document.body.textContent).not.toContain("10.26 pts");
  await act(() => userEvent.click(page.getByRole("button", { name: "Cancel" })));
  expect(document.body.textContent).not.toContain("1978 shares");
  expect(document.body.textContent).not.toMatch(/Buy pts|Stripe/i);
  await expect.element(page.getByText("Starting Grant")).toBeInTheDocument();

  await act(() => storeActions.navigate("/u/alice"));
  await act(() => userEvent.click(page.getByRole("tab", { name: "Likes" })));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Trades" })));
  await expect.element(page.getByText("BUY YES").first()).toBeInTheDocument();
});

it('Public post links preserve URL parentheses but not surrounding prose (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const orchard = "http://127.0.0.1:8787/resources/Orchard_(garden)";
  const club = "http://127.0.0.1:8787/resources/Club";
  const posts = [
    `Read the orchard page: ${orchard}`,
    `A link in prose (see ${club}).`,
    `The guide is available (see ${orchard}).`,
  ].map((content, index) => ({
    ...SAMPLE_POSTS[0],
    id: `garden-resource-${index}`,
    content,
    marketId: null,
    marketBadge: null,
    ticker: null,
    cashtags: [],
  }));
  const main = await mountCustomHomeFeed(posts);
  await expect.element(main.getByRole("link", { name: club, exact: true })).toHaveAttribute("href", club);
  const orchardLinks = main.getByRole("link", { name: orchard, exact: true });
  await expect.element(orchardLinks.first()).toHaveAttribute("href", orchard);
  await expect.element(orchardLinks.last()).toHaveAttribute("href", orchard);
  expect(orchardLinks.elements()).toHaveLength(2);
});

it('Latest News See all opens the full News list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const articles = Array.from({ length: 6 }, (_, index) => ({
    id: `garden-story-${index + 1}`,
    title: `Garden club story ${index + 1}`,
    body: "Community event news.",
    publishedAt: Date.now() - index * 60_000,
  }));
  const older = articles[5];
  await mountCustomMockApp({
    handle(path) {
      if (path === "/api/explore" || path === "/api/articles") return Promise.resolve(Response.json({ articles }));
      if (path === `/api/articles/${older.id}`) return Promise.resolve(Response.json(older));
      if (path === "/api/feed" || path === "/api/markets") return Promise.resolve(Response.json({ items: [], predictions: [], perps: [] }));
      return undefined;
    },
  });
  const home = page.getByRole("button", { name: "Home", exact: true }).first();
  const explore = page.getByRole("button", { name: "Explore", exact: true }).first();
  const main = page.getByRole("main");
  const news = main.getByRole("tab", { name: "News", exact: true });
  const olderArticle = main.getByRole("button", { name: `Read full article: ${older.title}`, exact: true });
  await act(() => userEvent.click(explore));
  await expect.element(main.getByRole("heading", { name: "Top Stories", exact: true })).toBeInTheDocument();
  await act(() => userEvent.click(home));
  const latestNews = page.getByRole("region", { name: "Latest news" });
  await act(() => userEvent.click(latestNews.getByRole("button", { name: "See all", exact: true })));
  await expect.element(news).toHaveAttribute("aria-selected", "true");
  await expect.element(olderArticle).toBeInTheDocument();

  await act(() => userEvent.click(olderArticle));
  await expect.element(main.getByRole("heading", { name: older.title, exact: true })).toBeInTheDocument();
  await act(() => userEvent.click(main.getByRole("button", { name: "Back", exact: true })));
  await expect.element(news).toHaveAttribute("aria-selected", "true");
  await expect.element(olderArticle).toBeInTheDocument();

  await act(() => userEvent.click(home));
  await act(() => userEvent.click(explore));
  await expect.element(main.getByRole("tab", { name: "Trending", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.element(olderArticle).not.toBeInTheDocument();
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

  const goToSide = async (side: "yes" | "no") => {
    await act(() => storeActions.navigate(`/markets/predictions/seed-market-1?side=${side}`));
    await expect.element(page.getByRole("button", { name: side === "yes" ? "Buy YES" : "Buy NO" })).toBeInTheDocument();
  };
  await goToSide("yes");
  await goToSide("no");

  await act(() => userEvent.click(page.getByRole("radio", { name: /YES \d+%/ })));
  await expect.element(page.getByRole("button", { name: "Buy YES" })).toBeInTheDocument();
  await goToSide("no");

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

  await selectSeedMarket(network);
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

  await selectSeedMarket(network);

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

async function openAliceTabThenNavigateBob(
  tabName: string,
  wasRequested: (handle: string) => boolean,
) {
  await act(() => storeActions.navigate("/u/alice"));
  await expect.element(page.getByText("Alice Aardvark").first()).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: tabName })));
  await act(() => Promise.resolve());
  expect(wasRequested("alice")).toBe(true);

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(wasRequested("bob")).toBe(false);
}

it('Late trades never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdTradesFor: "alice" });
  await openAliceTabThenNavigateBob("Trades", network.tradesRequested);

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
  await openAliceTabThenNavigateBob("Likes", network.likesRequested);

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

it('Back from a News article restores the full article list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const articles = Array.from({ length: 6 }, (_, index) => ({
    id: `garden-news-${index + 1}`,
    title: `Garden club bulletin ${index + 1}`,
    body: "The community plant swap starts on Saturday.",
    publishedAt: Date.now() - index * 60_000,
  }));
  const olderArticle = articles[5];
  const main = await mountCustomExploreArticles(articles);
  const news = main.getByRole("tab", { name: "News", exact: true });
  await act(() => userEvent.click(news));
  const openArticle = main.getByRole("button", { name: `Read full article: ${olderArticle.title}` });
  await act(() => userEvent.click(openArticle));
  await expect.element(main.getByRole("heading", { name: olderArticle.title, exact: true })).toBeInTheDocument();

  await act(() => userEvent.click(main.getByRole("button", { name: "Back", exact: true })));
  await expect.element(news).toHaveAttribute("aria-selected", "true");
  await expect.element(openArticle).toBeInTheDocument();
});

it('Back from a searched article keeps the selected search tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const article = {
    id: "garden-search-article",
    title: "Garden search bulletin",
    body: "The community plant swap starts on Saturday.",
    publishedAt: Date.now(),
  };
  await mountCustomMockApp({
    handle(path) {
      if (path === "/api/explore") return Promise.resolve(Response.json({ articles: [article] }));
      if (path === `/api/articles/${article.id}`) return Promise.resolve(Response.json(article));
      if (path === "/api/articles") return Promise.resolve(Response.json({ articles: [article] }));
      if (path === "/api/feed" || path === "/api/markets") return Promise.resolve(Response.json({ items: [], predictions: [], perps: [] }));
      return undefined;
    },
  });
  await act(() => userEvent.click(page.getByRole("button", { name: "Explore", exact: true }).first()));
  const main = page.getByRole("main");

  await act(() => userEvent.fill(main.getByLabelText("Search Feed"), "garden"));
  await act(() => userEvent.click(main.getByRole("button", { name: "Search", exact: true })));

  const people = main.getByRole("tab", { name: "People", exact: true });
  await act(() => userEvent.click(people));
  await expect.element(people).toHaveAttribute("aria-selected", "true");

  await act(() => storeActions.navigate(`/article/${article.id}`));
  await expect.element(main.getByRole("heading", { name: article.title, exact: true })).toBeInTheDocument();

  await act(() => userEvent.click(main.getByRole("button", { name: "Back", exact: true })));
  await expect.element(people).toHaveAttribute("aria-selected", "true");
});

it('A published article does not replace a trending tag list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const tagged = {
    ...SAMPLE_POSTS[0],
    id: "tagged-gardens",
    content: "Plant swap this Saturday #gardens",
    marketId: null,
    ticker: null,
    marketBadge: null,
    cashtags: [],
    hashtags: ["gardens"],
  };
  const untagged = { ...tagged, id: "untagged-gardens", content: "Private gardens open Tuesday", hashtags: [] };
  const article = { id: "garden-news", title: "Spring planting bulletin", body: "Community news", publishedAt: Date.now() };
  let published = false;
  await mountCustomMockApp({
    handle(path, url) {
      if (path === "/api/explore") {
        return Promise.resolve(Response.json({
          trending: [{ kind: "hashtag", tag: "#gardens", postCount: 1 }],
          articles: published ? [article] : [],
          search: { posts: url.searchParams.get("q") === "gardens" ? [tagged, untagged] : [] },
        }));
      }
      if (path === "/api/feed" || path === "/api/markets") return Promise.resolve(Response.json({ items: [], predictions: [], perps: [] }));
      if (path === "/api/trending/gardens") return Promise.resolve(Response.json({ tag: "gardens", posts: [tagged] }));
      if (path === "/api/articles") return Promise.resolve(Response.json({ articles: published ? [article] : [] }));
      return undefined;
    },
  });
  act(() => { reconnectRealtime(); });
  await act(() => userEvent.click(page.getByRole("button", { name: "Explore", exact: true }).first()));
  await act(() => userEvent.click(page.getByRole("main").getByRole("button", { name: /#gardens/ }).first()));
  await expect.element(page.getByText(tagged.content, { exact: true })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/trending/gardens");

  published = true;
  act(() => {
    liveEventSources.at(-1)?.dispatchEvent(new MessageEvent("article.published", {
      data: JSON.stringify({ type: "article.published", articleId: article.id, organizationId: "org-community" }),
    }));
  });

  expect(window.location.pathname).toBe("/trending/gardens");
  await expect.element(page.getByRole("button", { name: "Clear tag" })).toBeInTheDocument();
  await expect.element(page.getByText(tagged.content, { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText(untagged.content, { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText(article.title, { exact: true })).toBeInTheDocument();
});

it('Publishes a pasted post whose trimmed text fits the limit (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const text = "Garden club plant swap this Saturday. ".repeat(8).slice(0, 279) + ".";
  const submitted: string[] = [];
  await mountCustomMockApp({
    authenticated: true,
    handle(path, _url, init) {
      if (path === "/api/posts" && init?.method === "POST") {
        if (typeof init.body === "string") submitted.push(init.body);
        return Promise.resolve(Response.json({ ...SAMPLE_POSTS[0], id: "plant-swap", content: text }, { status: 201 }));
      }
      if (path === "/api/feed" || path === "/api/markets") return Promise.resolve(Response.json({ items: [], predictions: [], perps: [] }));
      return undefined;
    },
  });

  const main = page.getByRole("main");
  const draft = main.getByRole("textbox", { name: "Post text", exact: true });
  const publish = main.getByRole("button", { name: "Post", exact: true });
  await act(() => userEvent.fill(draft, text + "!"));
  await expect.element(publish).toBeDisabled();
  await expect.element(main.getByText("-1", { exact: true })).toBeInTheDocument();
  await act(() => userEvent.fill(draft, text + " "));
  await expect.element(publish).toBeEnabled();
  await expect.element(main.getByText("0", { exact: true })).toBeInTheDocument();
  await act(() => userEvent.fill(draft, text + "\n"));
  await expect.element(publish).toBeEnabled();
  await act(() => userEvent.click(publish));
  await expect.element(draft).toHaveValue("");
  expect(submitted).toEqual([JSON.stringify({ content: text })]);
});

it('Post copy controls report the clipboard outcome (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const post = {
    ...SAMPLE_POSTS[0],
    content: "Public plant swap on Saturday.",
    marketId: null,
    marketBadge: null,
    ticker: null,
    cashtags: [],
  };
  const writeText = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);
  const main = await mountCustomHomeFeed([post]);
  const copied = page.getByText("Link copied to clipboard.", { exact: true });
  await act(() => userEvent.click(main.getByRole("button", { name: "Share post", exact: true })));
  await expect.element(page.getByText("Could not copy the post link.", { exact: true })).toBeInTheDocument();
  await expect.element(copied).not.toBeInTheDocument();

  await act(() => userEvent.click(main.getByRole("button", { name: "More post actions", exact: true })));
  await act(() => userEvent.click(page.getByRole("menuitem", { name: "Copy link", exact: true })));
  await expect.element(copied).toBeInTheDocument();
  expect(writeText.mock.calls).toEqual([[`${window.location.origin}/post/${post.id}`], [`${window.location.origin}/post/${post.id}`]]);
  writeText.mockRestore();
});

it('Keyboard activation follows the hashtag inside a quoted post (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const original = {
    ...SAMPLE_POSTS[0],
    id: "garden-original",
    content: "The plant swap starts Saturday #gardens",
    marketId: null,
    marketBadge: null,
    ticker: null,
    cashtags: [],
    hashtags: ["gardens"],
  };
  const quote = {
    ...original,
    id: "garden-quote",
    content: "I'll bring some extra seeds.",
    hashtags: [],
    quotePostId: original.id,
    quotePost: original,
  };
  await mountCustomMockApp({
    handle(path) {
      if (path === "/api/feed") return Promise.resolve(Response.json({ items: [quote], nextCursor: null }));
      if (path === "/api/markets") return Promise.resolve(Response.json({ predictions: [], perps: [] }));
      if (path === "/api/trending/gardens") return Promise.resolve(Response.json({ tag: "gardens", posts: [original] }));
      return undefined;
    },
  });

  await act(() => userEvent.click(page.getByRole("button", { name: "Home", exact: true }).first()));
  const tag = page.getByRole("main").getByRole("button", { name: "#gardens", exact: true });
  await expect.element(tag).toBeInTheDocument();
  const tagButton = tag.element();
  if (tagButton instanceof HTMLElement) tagButton.focus();
  await expect.element(tag).toHaveFocus();
  await act(() => userEvent.keyboard("{Enter}"));
  await expect.element(page.getByRole("button", { name: "Clear tag", exact: true })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/trending/gardens");
});

it('Post detail uses the same local month as the rest of the timestamp (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const post = {
    ...SAMPLE_POSTS[0],
    id: "garden-month-boundary",
    content: "The October garden calendar is ready.",
    createdAt: new Date(2026, 9, 1, 0, 5).getTime(),
    marketId: null,
    marketBadge: null,
    ticker: null,
    cashtags: [],
  };
  const utcMonth = vi.spyOn(Date.prototype, "getUTCMonth").mockReturnValue(8);
  try {
    const main = await mountCustomHomeFeed([post], (path) =>
      path === `/api/posts/${post.id}` ? Promise.resolve(Response.json({ post, ancestors: [], replies: [] })) : undefined,
    );
    await act(() => userEvent.click(main.getByText(post.content, { exact: true })));
    await expect.element(main.getByText("12:05 AM · Oct 1, 2026", { exact: true })).toBeInTheDocument();
  } finally {
    utcMonth.mockRestore();
  }
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
  const network = await mountSignedInApp({ holdPnlRange: "1D" });

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

  act(() => {
    void storeActions.loadPnlHistory("1D");
  });
  await act(() => Promise.resolve());
  await act(() => storeActions.logout());
  network.releasePnl("1D");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  const { pnlTimeRange, pnlHistory, pnlHistoryLoading } = getStoreSnapshot();
  expect({ pnlTimeRange, pnlHistory, pnlHistoryLoading }).toEqual({ pnlTimeRange: "ALL", pnlHistory: [], pnlHistoryLoading: false });

  await act(() => userEvent.click(page.getByRole("button", { name: "Sign in" }).first()));
  await signInAsReviewer();
  await act(() => storeActions.selectFeedTab("following"));
  network.setFeedFails(true);
  await act(() => storeActions.logout());
  await act(() => userEvent.click(page.getByRole("button", { name: "Sign in" }).first()));
  await signInAsReviewer();
  expect(getStoreSnapshot().viewer?.accountId).toBe("acct-player-1");
  expect(getStoreSnapshot().feedTab).toBe("latest");

  network.setFeedFails(false);
  await act(() => storeActions.selectFeedTab("following"));
  await act(() => storeActions.loadPnlHistory("1W"));
  await act(() => storeActions.navigate("/u/alice"));
  const feedLoadsBeforeExpiry = fetchPaths.filter((path) => path === "/api/feed").length;
  network.expireSession();
  await act(() => hydrateAuth());
  const expired = getStoreSnapshot();
  expect({ viewer: expired.viewer, feedTab: expired.feedTab, pnlTimeRange: expired.pnlTimeRange, pnlHistory: expired.pnlHistory }).toEqual({ viewer: null, feedTab: "latest", pnlTimeRange: "ALL", pnlHistory: [] });
  expect({ route: expired.route, profileHandle: expired.profileBundle?.summary.handle }).toEqual({ route: "Profile", profileHandle: "alice" });
  expect(fetchPaths.filter((path) => path === "/api/feed").length).toBe(feedLoadsBeforeExpiry + 1);

  await act(() => userEvent.click(page.getByRole("button", { name: "Sign in" }).first()));
  await signInAsReviewer();
  await act(() => storeActions.selectFeedTab("following"));
  await act(() => storeActions.loadPnlHistory("1W"));
  const accountState = () => {
    const s = getStoreSnapshot();
    return { accountId: s.viewer?.accountId, feedTab: s.feedTab, pnlTimeRange: s.pnlTimeRange, pnlHistory: s.pnlHistory, followingPostShown: s.feedPosts.some((post) => post.card.id === "following-post-a") };
  };
  const accountA = accountState();
  expect(accountA).toMatchObject({ accountId: "acct-player-1", feedTab: "following", pnlTimeRange: "1W", followingPostShown: true });
  await act(() => hydrateAuth());
  expect(accountState()).toEqual(accountA);

  await act(() => storeActions.navigate("/post/browser-post-1"));
  network.switchAccount();
  await act(() => hydrateAuth());
  expect(accountState()).toEqual({ accountId: "acct-email-1", feedTab: "latest", pnlTimeRange: "ALL", pnlHistory: [], followingPostShown: false });
  expect({ route: getStoreSnapshot().route, threadPostId: getStoreSnapshot().activeThread?.post.card.id }).toEqual({ route: "PostDetail", threadPostId: "browser-post-1" });
});

it('Stale closed positions are dropped after a newer refresh (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
  const network = await mountSignedInApp({ holdClosedPositionsFirst: true });

  act(() => {
    void storeActions.loadClosedPositions();
  });
  await act(() => Promise.resolve());
  expect(network.closedPositionsRequested()).toBe(true);

  await act(() => storeActions.loadClosedPositions());
  expect(getStoreSnapshot().closedPositions).toHaveLength(1);
  expect(getStoreSnapshot().closedPositions[0]?.realizedPnlPts).toBe(222);

  network.releaseClosedPositions();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().closedPositions).toHaveLength(1);
  expect(getStoreSnapshot().closedPositions[0]?.realizedPnlPts).toBe(222);
  expect(getStoreSnapshot().closedPositionsLoading).toBe(false);
});

it('Stale economy is dropped after a newer refresh (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
  const network = await mountSignedInApp({ holdEconomyFirst: true });

  act(() => {
    void storeActions.loadEconomy();
  });
  await act(() => Promise.resolve());
  expect(network.economyRequested()).toBe(true);

  await act(() => storeActions.loadEconomy());
  expect(getStoreSnapshot().economy?.balanceCents).toBe(9900);
  expect(getStoreSnapshot().economy?.equityCents).toBe(10928);

  network.releaseEconomy();
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().economy?.balanceCents).toBe(9900);
  expect(getStoreSnapshot().economy?.equityCents).toBe(10928);
  expect(getStoreSnapshot().economyLoading).toBe(false);
});

it('Late replies never land on another profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const network = await mountApp({ holdProfileReplies: true });
  const openRepliesTab = async () => {
    await act(() => userEvent.click(page.getByRole("tab", { name: "Posts" })));
    await act(() => userEvent.click(page.getByRole("tab", { name: "Replies" })));
    await act(() => Promise.resolve());
  };

  await openAliceTabThenNavigateBob("Replies", network.repliesRequested);

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

it('Switching profiles never shows the previous profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  let bobRequested = false;
  let bobHeld = true;
  const bobReleases: Array<(res: Response) => void> = [];
  const releaseBob = () => {
    for (const release of bobReleases.splice(0)) release(Response.json(profilePayload("acc-bob", "bob", "Bob Badger")));
  };
  await mountCustomMockApp({
    handle: (path) => {
      if (path === "/api/users/alice") return Promise.resolve(Response.json(profilePayload("acc-alice", "alice", "Alice Aardvark")));
      if (path === "/api/users/bob" || path === "/api/users/acc-bob") {
        bobRequested = true;
        if (bobHeld) {
          return new Promise<Response>((resolve) => {
            bobReleases.push(resolve);
          });
        }
        return Promise.resolve(Response.json(profilePayload("acc-bob", "bob", "Bob Badger")));
      }
      if (path === "/api/feed" || path === "/api/posts") return Promise.resolve(Response.json({ items: SAMPLE_POSTS, nextCursor: null }));
      if (path === "/api/markets") return Promise.resolve(Response.json({ predictions: SAMPLE_MARKETS.predictions, perps: [] }));
      if (path === "/api/explore") return Promise.resolve(Response.json({ trending: [], articles: [], search: { posts: [], accounts: [], actors: [], organizations: [], tags: [] } }));
      if (path === "/api/leaderboard") return Promise.resolve(Response.json(SAMPLE_LEADERBOARD_PLAYERS));
      return undefined;
    },
  });

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
  await mountApp();

  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await expect.element(page.getByText("1 post")).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");

  profileShouldFail = true;
  liveEventSources.at(-1)?.dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => {
    expect(getStoreSnapshot().errorMessage).not.toBeNull();
    expect(getStoreSnapshot().profileLoading).toBe(false);
  });
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");
  expect(getStoreSnapshot().profileBundle?.posts.length).toBe(1);
  await expect.element(page.getByText("Profile not found")).not.toBeInTheDocument();
  await expect.element(page.getByText("1 post")).toBeInTheDocument();

  const expectMissingProfile = async (path: string, shouldFail: boolean) => {
    profileShouldFail = shouldFail;
    await act(async () => {
      await storeActions.navigate(path);
    });
    await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
    await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
    profileShouldFail = false;
    await act(async () => {
      await storeActions.navigate("/u/ailonmusk");
    });
    await vi.waitFor(() => expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk"));
  };

  await expectMissingProfile("/u/ghost", false);
  await expectMissingProfile("/u/other", true);
  profileShould404 = true;
  liveEventSources[0].dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShould404 = false;
});

async function mountExplorePredSearch(tabName: string) {
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
  await act(() => userEvent.click(page.getByRole("tab", { name: tabName })));
  return search;
}

it('Explore search "$PRED" lists the PRED org in the Orgs tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const search = await mountExplorePredSearch("Orgs");
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

it('Explore search "$PRED" lists the PRED market in the Markets tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await mountExplorePredSearch("Markets");
  await expect.element(page.getByText("No matching markets")).not.toBeInTheDocument();
  await expect.element(page.getByText("Max 20x")).toBeInTheDocument();
});

// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
it('Stale chats response is dropped when a newer load lands first', async () => {
  const chatSummary = (id: string, title: string) => ({ id, title, kind: "direct" });
  const messageRequests: string[] = [];
  let holdChats = false;
  let resolveHeld: (() => void) | undefined;
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  await mountCustomMockApp({
    authenticated: true,
    handle: (path) => {
      if (path === "/api/chats") {
        if (holdChats) {
          return new Promise<Response>((resolve) => {
            resolveHeld = () => resolve(Response.json({ chats: [chatSummary("chat-stale", "Stale Chat")] }));
          });
        }
        return json({ chats: [chatSummary("chat-fresh-a", "Fresh Chat A"), chatSummary("chat-fresh-b", "Fresh Chat B")] });
      }
      if (path === "/api/chats/chat-fresh-a/messages") {
        messageRequests.push("chat-fresh-a");
        return json({ messages: [chatMessage("msg-fa1", "Fresh A message")] });
      }
      if (path === "/api/chats/chat-fresh-b/messages") {
        messageRequests.push("chat-fresh-b");
        return json({ messages: [chatMessage("msg-fb1", "Fresh B message")] });
      }
      if (path === "/api/chats/chat-stale/messages") {
        messageRequests.push("chat-stale");
        return json({ messages: [chatMessage("msg-st1", "Stale chat message")] });
      }
      return undefined;
    },
  });

  const expectFreshChats = () => {
    expect(getStoreSnapshot().chats.map((c) => c.id)).toEqual(["chat-fresh-a", "chat-fresh-b"]);
    expect(getStoreSnapshot().selectedChatId).toBe("chat-fresh-a");
    expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Fresh A message"]);
  };

  holdChats = true;
  const loading = storeActions.loadChats();
  holdChats = false;
  await act(() => storeActions.loadChats());
  expectFreshChats();

  resolveHeld?.();
  await act(() => loading);

  expectFreshChats();
  expect(messageRequests).not.toContain("chat-stale");
  expect(getStoreSnapshot().chatsLoading).toBe(false);
});

// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"
it('Stale markets response is dropped when a newer load lands first', async () => {
  const marketPayload = (id: string, question: string) => ({
    predictions: [
      {
        id,
        slotIndex: 0,
        question,
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
  });
  let holdMarkets = false;
  let resolveHeld: (() => void) | undefined;
  await mountCustomMockApp({
    handle: (path) => {
      if (path === "/api/markets") {
        if (holdMarkets) {
          return new Promise<Response>((resolve) => {
            resolveHeld = () => resolve(Response.json(marketPayload("seed-market-stale", "Stale market question?")));
          });
        }
        return Promise.resolve(Response.json(marketPayload("seed-market-fresh", "Fresh market question?")));
      }
      return undefined;
    },
  });

  holdMarkets = true;
  const loading = storeActions.loadMarkets();
  holdMarkets = false;
  await act(() => storeActions.loadMarkets());
  expect(getStoreSnapshot().predictions.map((m) => m.card.id)).toEqual(["seed-market-fresh"]);

  resolveHeld?.();
  await act(() => loading);

  expect(getStoreSnapshot().predictions.map((m) => m.card.id)).toEqual(["seed-market-fresh"]);
  expect(getStoreSnapshot().predictions.map((m) => m.card.question)).toEqual(["Fresh market question?"]);
  expect(getStoreSnapshot().marketsLoading).toBe(false);
});

// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"
it('Stale notifications response is dropped after mark all read', async () => {
  const unreadItem = {
    id: "notif-race-1",
    kind: "like",
    title: "AIlon Musk liked your post",
    actorHandle: "ailonmusk",
    isRead: false,
    createdAt: Date.now() - 60_000,
  };
  let holdNotifications = false;
  let resolveHeld: (() => void) | undefined;
  await mountCustomMockApp({
    authenticated: true,
    handle: (path, _url, init) => {
      if (path === "/api/notifications/read") return Promise.resolve(Response.json({}));
      if (path === "/api/notifications") {
        if (init?.method === "POST") return Promise.resolve(Response.json({}));
        if (holdNotifications) {
          return new Promise<Response>((resolve) => {
            resolveHeld = () => resolve(Response.json({ notifications: [unreadItem] }));
          });
        }
        return Promise.resolve(Response.json({ notifications: [unreadItem] }));
      }
      return undefined;
    },
  });

  await act(() => storeActions.loadNotifications());
  expect(getStoreSnapshot().unreadNotifications).toBe(1);
  expect(getStoreSnapshot().notifications.map((n) => n.item.read)).toEqual([false]);

  holdNotifications = true;
  const loading = storeActions.loadNotifications();
  await act(() => storeActions.markAllNotificationsRead());
  expect(getStoreSnapshot().unreadNotifications).toBe(0);
  expect(getStoreSnapshot().notifications.map((n) => n.item.read)).toEqual([true]);

  resolveHeld?.();
  await act(() => loading);

  expect(getStoreSnapshot().unreadNotifications).toBe(0);
  expect(getStoreSnapshot().notifications.map((n) => n.item.read)).toEqual([true]);
  expect(getStoreSnapshot().notificationsLoading).toBe(false);
});

it('A deleted post disappears from Explore and Profile (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  installMockNetwork();
  explorePosts = [SAMPLE_POSTS[0]];
  await renderApp();
  await expect.element(page.getByText(SAMPLE_POSTS[0].content)).toBeInTheDocument();
  const dispatchPostDeletedAndExpectGone = async () => {
    liveEventSources[0].dispatchEvent(
      new MessageEvent("post.deleted", {
        data: JSON.stringify({ type: "post.deleted", postId: SAMPLE_POSTS[0].id, authorId: SAMPLE_POSTS[0].authorId }),
      }),
    );
    await expect.element(page.getByText(SAMPLE_POSTS[0].content)).not.toBeInTheDocument();
  };
  const feedFetchesBefore = fetchPaths.filter((path) => path === "/api/feed").length;
  await dispatchPostDeletedAndExpectGone();
  expect(fetchPaths.filter((path) => path === "/api/feed").length).toBe(feedFetchesBefore);
  await act(async () => {
    await storeActions.navigate("/explore");
    await storeActions.loadExplore("XTRPC");
  });
  await expect.element(page.getByText(SAMPLE_POSTS[0].content)).toBeInTheDocument();

  act(() => {
    setStoreState({ viewer: POST_DELETED_VIEWER, profileHandle: "ailonmusk" });
  });
  await act(async () => {
    await storeActions.loadProfile("ailonmusk");
  });
  const loaded = getStoreSnapshot().profileBundle;
  expect(loaded?.posts?.length).toBe(1);
  expect(loaded?.posts[0]?.card.id).toBe(SAMPLE_POSTS[0].id);
  const firstPost = loaded?.posts[0];
  if (firstPost !== undefined) {
    const secondPost = { ...firstPost, card: { ...firstPost.card, id: "browser-post-2" } };
    act(() => {
      const bundle = getStoreSnapshot().profileBundle;
      if (bundle !== null) {
        setStoreState({ profileBundle: { ...bundle, posts: [...bundle.posts, secondPost] } });
      }
    });
  }
  expect(getStoreSnapshot().profileBundle?.posts?.length).toBe(2);

  const fetchCallsBefore = fetchPaths.length;
  await dispatchPostDeletedAndExpectGone();
  expect(getStoreSnapshot().profileBundle).not.toBeNull();
  expect(getStoreSnapshot().profileBundle?.posts?.map((post) => post.card.id)).toEqual(["browser-post-2"]);
  expect(fetchPaths.length).toBe(fetchCallsBefore);

  liveEventSources[0].dispatchEvent(
    new MessageEvent("post.created", {
      data: JSON.stringify({
        type: "post.created",
        postId: "browser-post-2",
        authorId: "ailonmusk",
        authorKind: "npc",
        replyToPostId: null,
        quotePostId: null,
        createdAt: Date.now(),
      }),
    }),
  );
  expect(getStoreSnapshot().profileBundle?.posts?.map((post) => post.card.id)).toEqual(["browser-post-2"]);
  expect(fetchPaths.length).toBe(fetchCallsBefore);
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
  await mountCustomMockApp({
    authenticated: true,
    handle: (path) => {
      if (path === "/api/chats/chat-a/messages") {
        chatARequested = true;
        return new Promise<Response>((resolve) => {
          resolveChatA = () => resolve(Response.json({ messages: [chatMessage("msg-a1", "Chat A message")] }));
        });
      }
      if (path === "/api/chats/chat-b/messages") {
        return Promise.resolve(Response.json({ messages: [chatMessage("msg-b1", "Chat B message")] }));
      }
      return undefined;
    },
  });

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
  await mountCustomMockApp({
    authenticated: true,
    handle: (path) => {
      if (path === "/api/chats/chat-a/messages") {
        return Promise.resolve(Response.json({ messages: [chatMessage("msg-a1", "Chat A message")] }));
      }
      if (path === "/api/chats/chat-b/messages") {
        return new Promise<Response>((resolve) => {
          chatBReleases.push(resolve);
        });
      }
      if (path === "/api/chats") {
        return Promise.resolve(Response.json({
          chats: [
            { id: "chat-a", title: "Chat A", kind: "direct" },
            { id: "chat-b", title: "Chat B", kind: "direct" },
          ],
        }));
      }
      return undefined;
    },
  });

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

  const expectChatBSelected = async () => {
    await expect.element(page.getByRole("heading", { name: "Chat B" })).toBeInTheDocument();
    await expect.element(page.getByText("Chat A message")).not.toBeInTheDocument();
    expect(getStoreSnapshot().selectedChatId).toBe("chat-b");
    expect(getStoreSnapshot().chatMessages.map((m) => m.content)).toEqual(["Chat B message"]);
  };

  await expect.element(page.getByText("Chat B message")).toBeInTheDocument();
  await expectChatBSelected();

  await act(() => storeActions.loadChatMessages("chat-a"));
  await expectChatBSelected();
});

it('Stale profile response is dropped after navigating on (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  let aliceRequested = false;
  const aliceReleases: Array<(res: Response) => void> = [];
  const releaseAlice = (res: Response) => {
    for (const release of aliceReleases.splice(0)) release(res);
  };
  await mountCustomMockApp({
    handle: (path) => {
      if (path === "/api/users/alice") {
        aliceRequested = true;
        return new Promise<Response>((resolve) => {
          aliceReleases.push(resolve);
        });
      }
      if (path === "/api/users/bob") return Promise.resolve(Response.json(profilePayload("acc-bob", "bob", "Bob Badger")));
      return undefined;
    },
  });

  const navigateAliceThenBob = async (lateResponse: Response) => {
    const navAlice = storeActions.navigate("/u/alice");
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(aliceRequested).toBe(true);
    expect(getStoreSnapshot().profileHandle).toBe("alice");

    await act(() => storeActions.navigate("/u/bob"));
    await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
    expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");

    releaseAlice(lateResponse);
    await act(() => navAlice);

    await expect.element(page.getByText("Bob Badger").first()).toBeInTheDocument();
    expect(getStoreSnapshot().profileHandle).toBe("bob");
    expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");
    expect(getStoreSnapshot().profileLoading).toBe(false);
  };

  await navigateAliceThenBob(Response.json(profilePayload("acc-alice", "alice", "Alice Aardvark")));
  await expect.element(page.getByText("Alice Aardvark")).not.toBeInTheDocument();

  await navigateAliceThenBob(new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }));
  expect(getStoreSnapshot().errorMessage).toBeNull();
});

function profilePost(id: string, content: string) {
  return makePostRecord({ id, content, isParody: false, parodyLabel: null });
}

function profilePayloadWithPosts(posts: unknown[], nextCursor: string | null) {
  return {
    profile: { id: "acc-bob", handle: "bob", displayName: "Bob Badger", kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts,
    positions: {},
    nextCursor,
  };
}

it('Stale profile page is dropped after a profile refresh (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const bobNew = profilePost("bob-new", "Bob newest post.");
  const bobOne = profilePost("bob-1", "Bob first page post.");
  const stalePost = profilePost("bob-stale", "Bob stale page post.");
  let refreshed = false;
  let resolveStalePage: (() => void) | undefined;
  await mountCustomMockApp({
    handle: (path, url) => {
      if (path === "/api/users/bob") {
        if (url.searchParams.get("cursor")) {
          return new Promise<Response>((resolve) => {
            resolveStalePage = () => resolve(Response.json(profilePayloadWithPosts([stalePost], "bob-cursor-stale")));
          });
        }
        return Promise.resolve(Response.json(
          refreshed
            ? profilePayloadWithPosts([bobNew, bobOne], "bob-cursor-2")
            : profilePayloadWithPosts([bobNew], "bob-cursor-1"),
        ));
      }
      return undefined;
    },
  });

  await act(() => storeActions.loadProfile("bob"));
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-1");

  const loadingMore = storeActions.loadMoreProfilePosts();
  refreshed = true;
  await act(() => storeActions.loadProfile("bob"));
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new", "bob-1"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-2");

  resolveStalePage?.();
  await act(() => loadingMore);

  await expect.element(page.getByText("Bob stale page post.")).not.toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new", "bob-1"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-2");
  expect(getStoreSnapshot().profileLoadingMore).toBe(false);
});

it('Phone SMS door sends national numbers as E.164 (spec/app/onboarding.md, "Story: Sign in through the Phone SMS door, AI Agent SKILL.md door, or Reviewer link")', async () => {
  phoneStartRequests.length = 0;
  await mountApp();

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  const join = page.getByRole("dialog", { name: "Join Feed" });
  await expect.element(join).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Phone" })));

  await act(() => userEvent.click(page.getByRole("combobox", { name: "Country" })));
  await act(() => userEvent.click(page.getByRole("option", { name: "United Kingdom (+44)" })));
  await act(() => userEvent.fill(page.getByLabelText("Mobile number (non-VoIP)"), "07700900123"));
  await act(() => userEvent.click(page.getByRole("button", { name: "Send 6-digit SMS code" })));
  await expect.element(page.getByLabelText("6-digit SMS code")).toBeInTheDocument();
  expect(phoneStartRequests).toHaveLength(1);
  expect(phoneStartRequests[0]?.phoneE164).toBe("+447700900123");

  await act(() => userEvent.click(join.getByRole("button", { name: "Close" })));
  await act(() => userEvent.click(page.getByRole("button", { name: "Sign in" }).first()));
  await expect.element(page.getByRole("dialog", { name: "Join Feed" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("tab", { name: "Phone" })));
  await act(() => userEvent.click(page.getByRole("combobox", { name: "Country" })));
  await act(() => userEvent.click(page.getByRole("option", { name: "France (+33)" })));
  await act(() => userEvent.fill(page.getByLabelText("Mobile number (non-VoIP)"), "06 12 34 56 78"));
  await act(() => userEvent.click(page.getByRole("button", { name: "Send 6-digit SMS code" })));
  await expect.element(page.getByLabelText("6-digit SMS code")).toBeInTheDocument();
  expect(phoneStartRequests).toHaveLength(2);
  expect(phoneStartRequests[1]?.phoneE164).toBe("+33612345678");
});

async function clickHomeAndExpectFeedPost() {
  const homeButton = page.getByRole("button", { name: "Home", exact: true }).first();
  await act(() => userEvent.click(homeButton));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
}

it('Social-mode Back lands on Home with a matching URL (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  await mountApp();
  await clickHomeAndExpectFeedPost();

  const marketsButton = page.getByRole("button", { name: "Markets", exact: true }).first();
  await act(() => userEvent.click(marketsButton));
  await expect.element(page.getByRole("heading", { name: "Markets", exact: true }).first()).toBeInTheDocument();
  await vi.waitFor(() => {
    expect(window.location.pathname).toBe("/markets");
  });

  const modeSwitch = page.getByRole("switch", { name: "Social mode" }).first();
  await act(() => userEvent.click(modeSwitch));
  await vi.waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();

  const pushState = vi.spyOn(window.history, "pushState");
  const replaceState = vi.spyOn(window.history, "replaceState");
  const popped = new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
  window.history.back();
  await act(() => popped);
  expect(window.location.pathname).toBe("/");
  expect(pushState).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(getStoreSnapshot().route).toBe("Home");
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Markets", exact: true }).first()).not.toBeInTheDocument();

  const poppedAgain = new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
  window.history.back();
  await act(() => poppedAgain);
  expect(window.location.pathname).toBe("/");
  expect(pushState).not.toHaveBeenCalled();
  expect(getStoreSnapshot().route).toBe("Home");
  pushState.mockRestore();
  replaceState.mockRestore();
});

const SAMPLE_THREAD = {
  post: SAMPLE_POSTS[0],
  parentPost: null,
  replies: [],
};

const SAMPLE_THREAD_B = {
  post: { ...SAMPLE_POSTS[0], id: "browser-post-2", content: "Second post for the stale thread fetch probe.", createdAt: Date.now() - 30_000 },
  parentPost: null,
  replies: [],
};

async function openThreadDetail() {
  await renderApp();
  await clickHomeAndExpectFeedPost();
  const replyButton = page.getByRole("button", { name: /^Reply/ }).first();
  await act(() => userEvent.click(replyButton));
  await expect.element(page.getByRole("heading", { name: "Post", exact: true }).first()).toBeInTheDocument();
}

it('Thread close during load stays closed (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const threadGate = { release: () => {} };
  let threadConsumed = false;
  const threadBody = Response.json(SAMPLE_THREAD);
  const readThreadBody = threadBody.text.bind(threadBody);
  threadBody.text = async () => {
    threadConsumed = true;
    return readThreadBody();
  };
  const threadResponse = new Promise<Response>((resolve) => {
    threadGate.release = () => resolve(threadBody);
  });
  installMockNetwork({ threadFetch: (path) => (path.startsWith("/api/posts/") ? threadResponse : null) });
  await openThreadDetail();

  await act(() => userEvent.click(page.getByRole("button", { name: "Back" }).first()));
  await vi.waitFor(() => {
    expect(getStoreSnapshot().route).toBe("Home");
  });

  threadGate.release();
  await vi.waitFor(() => {
    expect(threadConsumed).toBe(true);
  });
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().activeThread).toBeNull();
  expect(getStoreSnapshot().threadLoading).toBe(false);
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
});

it('Stale thread fetch loses to a newer open (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const gates = new Map<string, { release: () => void }>();
  const threadResponses = new Map<string, Promise<Response>>();
  for (const [id, thread] of [
    ["browser-post-1", SAMPLE_THREAD],
    ["browser-post-2", SAMPLE_THREAD_B],
  ] as const) {
    const gate = { release: () => {} };
    threadResponses.set(
      id,
      new Promise<Response>((resolve) => {
        gate.release = () => resolve(Response.json(thread));
      }),
    );
    gates.set(id, gate);
  }
  installMockNetwork({
    threadFetch: (path) => {
      const id = path.startsWith("/api/posts/") ? decodeURIComponent(path.slice("/api/posts/".length)) : null;
      return id === null ? null : (threadResponses.get(id) ?? null);
    },
  });
  await openThreadDetail();

  act(() => {
    void storeActions.openThread("browser-post-2");
  });
  gates.get("browser-post-2")?.release();
  gates.get("browser-post-1")?.release();
  await vi.waitFor(() => {
    expect(getStoreSnapshot().activeThread?.post.card.id).toBe("browser-post-2");
  });
  await expect.element(page.getByText("Second post for the stale thread fetch probe.")).toBeInTheDocument();
});

it('Shows the not-found screen when a reply disappears before opening (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const parent = { ...SAMPLE_THREAD.post, content: "Plant swap on Saturday.", marketId: null, marketBadge: null, ticker: null, cashtags: [] };
  const reply = {
    ...parent,
    id: "removed-reply",
    replyToPostId: parent.id,
    content: "I'll bring some extra seeds.",
  };
  installMockNetwork({
    threadFetch: (path) => {
      if (path === `/api/posts/${parent.id}`) {
        return Promise.resolve(Response.json({ ...SAMPLE_THREAD, post: parent, replies: [reply] }));
      }
      if (path === `/api/posts/${reply.id}`) {
        return Promise.resolve(Response.json({ error: "Post not found" }, { status: 404 }));
      }
      return null;
    },
  });
  await openThreadDetail();
  await expect.element(page.getByText(parent.content, { exact: true })).toBeInTheDocument();

  await act(() => userEvent.click(page.getByText(reply.content, { exact: true })));
  expect(window.location.pathname).toBe(`/post/${reply.id}`);
  await expect.element(page.getByRole("button", { name: "Back to Home" })).toBeInTheDocument();
  await expect.element(page.getByText(parent.content, { exact: true })).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: "Back", exact: true })));
  await expect.element(page.getByText(parent.content, { exact: true })).toBeInTheDocument();
  expect(window.location.pathname).toBe(`/post/${parent.id}`);
});

it('Opening another article replaces all paragraphs even when two share an opener (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const opener = "The neighborhood garden volunteers will ";
  const firstParagraph = opener + "bring seeds for the morning exchange.";
  const secondParagraph = opener + "sort tools for the afternoon workshop.";
  const libraryParagraph = "The library will be open to readers until five.";
  const garden = {
    id: "garden-schedule",
    title: "Garden Volunteer Schedule",
    body: `${firstParagraph}\n\n${secondParagraph}`,
    publishedAt: Date.now() - 60_000,
  };
  const library = {
    id: "library-hours",
    title: "Library Holiday Hours",
    body: `## Saturday opening\n\n${libraryParagraph}`,
    publishedAt: Date.now(),
  };
  const main = await mountCustomExploreArticles([library, garden]);
  const earlier = main.getByText(firstParagraph, { exact: true });
  const later = main.getByText(secondParagraph, { exact: true });
  await act(() => userEvent.click(main.getByRole("button", { name: `Read full article: ${garden.title}` })));
  await expect.element(earlier).toBeInTheDocument();
  await expect.element(later).toBeInTheDocument();
  await act(() => userEvent.click(main.getByRole("button", { name: `Read full article: ${library.title}` })));
  await expect.element(main.getByText(libraryParagraph, { exact: true })).toBeInTheDocument();
  await expect.element(earlier).not.toBeInTheDocument();
  await expect.element(later).not.toBeInTheDocument();
});
