// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useSyncExternalStore } from "react";
import type { AppNavRoute } from "@repo/ui";
import type { AppRoute } from "../../gen/app__navigation.ts";
import { type SettingsTabId, parseLocation, routeToPath } from "./routes.ts";
import {
  adminCreateWorldFact,
  adminDeleteWorldFact,
  adminFastForward,
  adminResolveHold,
  adminResolveReport,
  adminRunCron,
  approveDeviceCode,
  completeEmailOnboard,
  completePhoneOnboard,
  confirmPhoneChange,
  copySkillPrompt,
  deleteAccount,
  dismissBottomBanner,
  dismissExplainer,
  fetchLoopbackCode,
  formatPhoneToE164,
  hydrateAuth,
  launchAgentHost,
  loadAdminReports,
  loadAdminStatus,
  loadAdminUsers,
  loadAdminWorldFacts,
  loadOAuthConsent,
  loadSkillsHosts,
  logout,
  lookupDeviceCode,
  openJoinSheet,
  requestEmailMagicLink,
  requestSmsCode,
  resendEmailMagicLink,
  resendSmsCode,
  revokeAgentGrant,
  setJoinEmailStep,
  setJoinPhoneStep,
  setJoinSheetOpen,
  setJoinTab,
  setPlayMode,
  signOutEverywhere,
  startEmailLink,
  startPhoneChange,
  submitOAuthDecision,
  submitReviewerLogin,
  toggleUiModeFromControl,
  verifyEmailMagicLink,
  verifySmsCode,
} from "./store-auth.ts";
import {
  applyDocumentTheme,
  canEnterRoute,
  clearNotices,
  clearReplyFailureNotice,
  closeBlockDialog,
  closeComposeDialog,
  closeDeletePostDialog,
  closeMuteDialog,
  closeReportDialog,
  consumeInitialChatId,
  consumeInitialEmailMagicToken,
  currentUiMode,
  cycleThemePreference,
  decrementSpaNavDepth,
  dismissToast,
  getStoreSnapshot,
  hasInternalBackHistory,
  incrementSpaNavDepth,
  navRuntime,
  openBlockDialog,
  openComposeDialog,
  openDeletePostDialog,
  openMuteDialog,
  openReportDialog,
  pushBrowserRoute,
  pushToast,
  recordPublicView,
  registerAuthChangedHook,
  registerNavigateHook,
  requireAuthOrQueue,
  sendApp,
  sendNav,
  setStoreState,
  setThemePreference,
  subscribeStore,
  toggleWatchlistItem,
} from "./store-core.ts";
import {
  clearNotifications,
  closeFollowList,
  closePerpPosition,
  closeThread,
  createGroupChat,
  createPost,
  deleteGroupChat,
  deletePost,
  flushPendingNewPosts,
  inviteToGroupChat,
  jumpToMyLeaderboardRank,
  leaveGroupChat,
  loadArticle,
  loadChatMessages,
  loadChats,
  loadClosedPositions,
  loadEconomy,
  selectChat,
  loadExplore,
  loadFeed,
  loadFollowList,
  loadLeaderboard,
  loadMarketDetails,
  loadMarkets,
  loadModerationLists,
  loadMoreFeed,
  loadMoreProfilePosts,
  loadNotifications,
  loadPnlHistory,
  loadPositionsSilent,
  loadProfile,
  loadProfileLikes,
  loadProfileReplies,
  loadProfileTrades,
  loadTrending,
  loadTrendingTag,
  loadWorldStatus,
  markAllNotificationsRead,
  markLikeOwnEngagementLanded,
  markLikeServerCountLanded,
  markReplyLiveCountLanded,
  markRepostOwnEngagementLanded,
  markRepostServerCountLanded,
  markChatRead,
  markNotificationRead,
  openMarketsDashboard,
  openThread,
  patchPostCardAcrossStore,
  previewPerpOrder,
  reactToChatMessage,
  recordLiveEngagementCounts,
  rebalancePerpPosition,
  removeGroupMember,
  removePostAcrossStore,
  renameGroupChat,
  repostPost,
  respondGroupInvite,
  searchAccounts,
  selectFeedTab,
  selectMarket,
  sendChatMessage,
  setMarketTimeRange,
  startDirectChat,
  submitPerpOrder,
  submitPredictionOrder,
  submitReport,
  toggleBlock,
  toggleFollow,
  toggleLike,
  toggleMute,
  transferGroupOwnership,
  updateOwnProfile,
} from "./store-world.ts";
import { isRecord, num, optStr } from "./types.ts";

type SseDomain = "feed" | "markets" | "explore" | "profile" | "chats" | "notifications" | "auth";

let booted = false;
let activeEventSource: EventSource | null = null;
let lastFallbackRefreshAt = 0;
const sseDomainInFlight = new Set<SseDomain>();
const sseDomainPending = new Map<SseDomain, () => Promise<void>>();

async function runDomainRefresh(domain: SseDomain, task: () => Promise<void>): Promise<void> {
  if (sseDomainInFlight.has(domain)) {
    sseDomainPending.set(domain, task);
    return;
  }
  sseDomainInFlight.add(domain);
  try {
    await task();
  } finally {
    sseDomainInFlight.delete(domain);
    const queued = sseDomainPending.get(domain);
    if (queued) {
      sseDomainPending.delete(domain);
      void runDomainRefresh(domain, queued);
    }
  }
}

async function loadDataForRoute(route: AppRoute, search = ""): Promise<void> {
  const s = getStoreSnapshot();
  switch (route) {
    case "Home":
      await loadFeed();
      return;
    case "PostDetail":
      if (s.activePostId) await openThread(s.activePostId, s.threadSort);
      return;
    case "Explore":
      if (s.activeArticleId) {
        await loadArticle(s.activeArticleId);
      } else if (s.activeTrendingTag) {
        await loadTrendingTag(s.activeTrendingTag);
      } else {
        await loadExplore(s.exploreQuery);
      }
      return;
    case "Markets": {
      const tasks: Promise<void>[] = [loadMarkets(), loadWorldStatus()];
      if (s.walletView && s.viewer) {
        tasks.push(loadEconomy(), loadClosedPositions(), loadPnlHistory());
      }
      await Promise.all(tasks);
      return;
    }
    case "Leaderboard":
      await Promise.all([loadLeaderboard(), loadWorldStatus()]);
      return;
    case "Chats": {
      const params = new URLSearchParams(search);
      const chatId = params.get("chat")?.trim() || consumeInitialChatId() || s.selectedChatId;
      await loadChats(true, chatId);
      return;
    }
    case "Notifications":
      await loadNotifications();
      return;
    case "Profile":
      await loadProfile();
      return;
    case "Settings":
      await Promise.all([loadSkillsHosts(), loadModerationLists()]);
      return;
    case "HowToPlay":
      await loadSkillsHosts();
      return;
    case "OAuthConsent":
      await loadOAuthConsent(search);
      return;
    case "AuthEmail": {
      const params = new URLSearchParams(search);
      const token = params.get("token")?.trim() || consumeInitialEmailMagicToken();
      if (typeof window !== "undefined" && window.location.search.includes("token=")) {
        window.history.replaceState(null, "", "/auth/email");
      }
      await verifyEmailMagicLink(token);
      return;
    }
    case "Admin":
      await Promise.all([loadAdminStatus(), loadAdminReports("open"), loadAdminUsers(""), loadAdminWorldFacts()]);
      return;
    case "Link": {
      const params = new URLSearchParams(search);
      const code = params.get("userCode")?.trim() || params.get("user_code")?.trim() || "";
      if (code) {
        await lookupDeviceCode(code);
      }
      return;
    }
  }
}

function applyParsedLocation(parsed: ReturnType<typeof parseLocation>, exploreNewsRequest: number | null = null): void {
  const prevPostId = getStoreSnapshot().activePostId;
  if (prevPostId !== null && parsed.postId !== prevPostId) {
    clearReplyFailureNotice(prevPostId);
  }
  if (getStoreSnapshot().route === "PostDetail" && parsed.route !== "PostDetail") {
    closeThread();
  }
  const followList = getStoreSnapshot();
  if (
    followList.followListKind !== null
    && (parsed.route !== "Profile"
      || (parsed.profileHandle ?? "").toLowerCase() !== (followList.followListHandle ?? "").toLowerCase())
  ) {
    closeFollowList();
  }
  const enteringTerminal = Boolean(parsed.marketId || parsed.queryTicker);
  const currentSelection = getStoreSnapshot();
  const nextMarketKind = parsed.marketKind ?? (parsed.queryTicker ? ("perp" as const) : null);
  const nextMarketId = parsed.marketId ?? parsed.queryTicker;
  const sameMarketSelection =
    nextMarketKind !== null &&
    nextMarketId !== null &&
    currentSelection.selectedMarketKind === nextMarketKind &&
    (nextMarketKind === "perp"
      ? currentSelection.selectedMarketId?.toUpperCase() === nextMarketId.toUpperCase()
      : currentSelection.selectedMarketId === nextMarketId);
  const clearsTradeError =
    parsed.route === "Markets" && (!enteringTerminal || !sameMarketSelection);
  setStoreState({
    route: parsed.route,
    profileHandle: parsed.profileHandle,
    activePostId: parsed.postId,
    activeArticleId: parsed.articleId,
    activeTrendingTag: parsed.trendingTag,
    exploreNewsRequest,
    walletView: parsed.walletView,
    ...(parsed.exploreQuery !== null ? { exploreQuery: parsed.exploreQuery } : {}),
    ...(parsed.settingsTab ? { settingsTab: parsed.settingsTab } : {}),
    ...(parsed.chatId ? { selectedChatId: parsed.chatId } : {}),
    selectedTicker: parsed.queryTicker,
    ...(parsed.route === "Markets"
      ? {
          marketsViewMode: enteringTerminal ? ("terminal" as const) : ("dashboard" as const),
          perpPreview: null,
          ...(clearsTradeError ? { tradeError: null } : {}),
        }
      : {}),
    ...(parsed.marketKind && parsed.marketId
      ? {
          selectedMarketKind: parsed.marketKind,
          selectedMarketId: parsed.marketId,
          selectedMarketSide: parsed.marketSide ?? "YES",
          marketSideIntentSeq: getStoreSnapshot().marketSideIntentSeq + 1,
        }
      : parsed.queryTicker
        ? { selectedMarketKind: "perp" as const, selectedMarketId: parsed.queryTicker }
        : {}),
  });
}

function guardRouteAccess(parsed: ReturnType<typeof parseLocation>, rawPath: string): "allow" | "blocked_auth" | "blocked_redirect" {
  const mode = currentUiMode();
  const blockedInSocial = mode === "SocialMode" && (parsed.route === "Markets" || parsed.route === "Leaderboard" || parsed.walletView);
  if (parsed.route === "OAuthConsent" || parsed.route === "AuthEmail" || parsed.route === "Link") {
    return "allow";
  }
  if (!canEnterRoute(parsed.route) || blockedInSocial) {
    const s = getStoreSnapshot();
    if (s.viewer === null && (parsed.route === "Chats" || parsed.route === "Notifications" || parsed.route === "Settings")) {
      const label = parsed.route === "Chats"
        ? "open Chats"
        : parsed.route === "Notifications"
          ? "view Notifications"
          : "open Settings";
      requireAuthOrQueue({ kind: "navigate", path: rawPath, label });
      return "blocked_auth";
    }
    if (blockedInSocial) {
      pushToast("Switch to Game mode to view Markets and Leaderboard.", "info");
    }
    return "blocked_redirect";
  }
  return "allow";
}

async function redirectToHome(options?: { readonly replace?: boolean }): Promise<void> {
  const prevPostId = getStoreSnapshot().activePostId;
  if (prevPostId !== null) {
    clearReplyFailureNotice(prevPostId);
  }
  if (options?.replace) {
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  } else {
    pushBrowserRoute("Home");
  }
  sendNav({ type: "navigateTo", targetRoute: "Home" });
  sendApp({ type: "navigateApp", targetRoute: "Home" });
  setStoreState({
    route: "Home",
    profileHandle: null,
    activePostId: null,
    activeArticleId: null,
    activeTrendingTag: null,
    walletView: false,
  });
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
    window.scrollTo(0, 0);
  }
  await loadFeed();
}

async function navigateWithNewsRequest(path: string, exploreNewsRequest: number | null): Promise<void> {
  const url = new URL(path, "https://feed.local");
  const parsed = parseLocation(url.pathname, url.search);
  clearNotices();
  const guard = guardRouteAccess(parsed, `${url.pathname}${url.search}`);
  if (guard === "blocked_auth") return;
  if (guard === "blocked_redirect") {
    await redirectToHome();
    return;
  }
  if (typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== parsed.canonicalPath) {
      if (parsed.replaceCanonical) {
        window.history.replaceState(null, "", parsed.canonicalPath);
      } else {
        incrementSpaNavDepth();
        window.history.pushState(null, "", parsed.canonicalPath);
      }
    }
    if (typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
  }
  sendNav({ type: "navigateTo", targetRoute: parsed.route });
  sendApp({ type: "navigateApp", targetRoute: parsed.route });
  recordPublicView(parsed.route);
  applyParsedLocation(parsed, exploreNewsRequest);
  await loadDataForRoute(parsed.route, url.search);
}

export function navigate(path: string): Promise<void> {
  return navigateWithNewsRequest(path, null);
}

let nextExploreNewsRequest = 0;

function openExploreNews(): void {
  void navigateWithNewsRequest("/explore", ++nextExploreNewsRequest);
}

export function navigateRoute(route: AppNavRoute): void {
  if (route === "Wallet") {
    void navigate("/wallet");
    return;
  }
  const s = getStoreSnapshot();
  const handle = route === "Profile" ? s.viewer?.handle ?? s.profileHandle : null;
  void navigate(routeToPath(route, { profileHandle: handle }));
}

export function setSettingsTab(tab: SettingsTabId): void {
  setStoreState({ settingsTab: tab });
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", `/settings?tab=${encodeURIComponent(tab)}`);
  }
  if (tab === "privacy") {
    void loadModerationLists();
  }
}

export function setExploreUrlQuery(q: string): void {
  const trimmed = q.trim();
  const nextPath = trimmed ? `/explore?q=${encodeURIComponent(trimmed)}` : "/explore";
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", nextPath);
  }
  setStoreState({ activeArticleId: null, activeTrendingTag: null, exploreQuery: q });
  void loadExplore(q);
}

function parseSseData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function refreshActiveRouteIfStale(minGapMs: number): void {
  const now = Date.now();
  if (now - lastFallbackRefreshAt < minGapMs) return;
  lastFallbackRefreshAt = now;
  const s = getStoreSnapshot();
  if (s.route === "AuthEmail") return;
  void runDomainRefresh("feed", async () => {
    await loadWorldStatus();
    if (s.route === "Home") {
      await loadFeed();
    } else if (s.route === "Markets") {
      await loadMarkets();
      if (s.walletView && s.viewer) {
        await Promise.all([loadEconomy(), loadClosedPositions(), loadPnlHistory()]);
      }
    } else if (s.route === "Leaderboard") {
      await loadLeaderboard();
    } else if (s.route === "Chats" && s.viewer) {
      await loadChats(false);
      if (s.selectedChatId) await loadChatMessages(s.selectedChatId);
    } else if (s.route === "Notifications" && s.viewer) {
      await loadNotifications();
    }
  });
}

function refreshExploreFromRealtime(): Promise<void> {
  const { route, activeTrendingTag } = getStoreSnapshot();
  return route === "Explore" && !activeTrendingTag ? loadExplore() : loadTrending();
}

function handleSseEvent(eventType: string, rawData: unknown): void {
  const data = parseSseData(rawData);
  const s = getStoreSnapshot();

  if (eventType === "post.engagement" && data) {
    const postId = optStr(data.postId);
    if (postId) {
      const likeCount = typeof data.likeCount === "number" ? data.likeCount : undefined;
      const repostCount = typeof data.repostCount === "number" ? data.repostCount : undefined;
      if (likeCount !== undefined) markLikeServerCountLanded(postId);
      if (repostCount !== undefined) markRepostServerCountLanded(postId);
      const engagementKind = optStr(data.kind);
      if (engagementKind && optStr(data.accountId) === s.viewer?.accountId) {
        markLikeOwnEngagementLanded(postId, engagementKind);
        markRepostOwnEngagementLanded(postId, engagementKind);
      }
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        ...(likeCount !== undefined ? { likeCount } : {}),
        ...(repostCount !== undefined ? { repostCount } : {}),
      }));
      recordLiveEngagementCounts(postId, { likeCount, repostCount });
    }
    return;
  }

  if (eventType === "post.deleted" && data) {
    const postId = optStr(data.postId);
    if (postId) {
      removePostAcrossStore(postId, {
        replyToPostId: optStr(data.replyToPostId),
        parentReplyCount: typeof data.parentReplyCount === "number" ? data.parentReplyCount : null,
      });
    }
    return;
  }

  if (eventType === "post.created" || eventType === "org.posted") {
    const replyToPostId = data ? optStr(data.replyToPostId) : null;
    const parentReplyCount = data && typeof data.parentReplyCount === "number" ? data.parentReplyCount : null;
    if (replyToPostId && parentReplyCount !== null) {
      const createdPostId = data ? optStr(data.postId) : null;
      if (createdPostId) markReplyLiveCountLanded(createdPostId);
      patchPostCardAcrossStore(replyToPostId, (card) => ({
        ...card,
        replyCount: Math.max(0, parentReplyCount),
      }));
    }
    if (s.route === "PostDetail" && s.activePostId && replyToPostId === s.activePostId) {
      void runDomainRefresh("feed", () => openThread(s.activePostId ?? "", s.threadSort));
      return;
    }
    if (s.route === "Home" && replyToPostId === null) {
      const scrolledDown = typeof window !== "undefined" && window.scrollY > 120;
      const paginated = s.feedPosts.length > 25;
      if (scrolledDown || paginated) {
        setStoreState({ pendingNewPostCount: s.pendingNewPostCount + 1 });
      } else {
        void runDomainRefresh("feed", () => loadFeed());
      }
    }
    return;
  }

  if (eventType === "article.published") {
    void runDomainRefresh("explore", refreshExploreFromRealtime);
    return;
  }

  if (eventType.startsWith("market.") || eventType === "world.tick") {
    if (eventType === "world.tick") {
      void loadWorldStatus();
    }
    if (s.route === "Markets" || s.route === "Leaderboard") {
      void runDomainRefresh("markets", async () => {
        if (s.route === "Leaderboard") {
          await loadLeaderboard();
          return;
        }
        await loadMarkets();
        if (s.walletView && s.viewer) {
          await Promise.all([loadEconomy(), loadClosedPositions(), loadPnlHistory()]);
        } else {
          const latest = getStoreSnapshot();
          if (latest.marketsViewMode === "terminal" && latest.selectedMarketId) {
            await loadMarketDetails(latest.selectedMarketKind, latest.selectedMarketId);
          }
        }
      });
    }
    if (s.route === "Explore") {
      void runDomainRefresh("explore", refreshExploreFromRealtime);
    }
    if (s.route === "Profile") {
      void runDomainRefresh("profile", () => loadProfile());
    }
    if (s.viewer) {
      void runDomainRefresh("auth", () => hydrateAuth());
    }
    return;
  }

  if (eventType.startsWith("chat.") || eventType === "alpha.invite") {
    if (!s.viewer) return;
    const chatId = data ? optStr(data.chatId) : null;
    void runDomainRefresh("chats", async () => {
      const live = getStoreSnapshot();
      if (eventType === "chat.updated") {
        await loadChats(live.route === "Chats");
        return;
      }
      if (live.route === "Chats" && chatId && chatId === live.selectedChatId) {
        await loadChatMessages(chatId);
        await loadChats(false);
      } else {
        await loadChats(live.route === "Chats");
      }
    });
    return;
  }

  if (eventType === "notification.created") {
    if (!s.viewer) return;
    if (data && typeof data.unreadCount === "number") {
      setStoreState({ unreadNotifications: num(data.unreadCount, s.unreadNotifications + 1) });
    }
    void runDomainRefresh("notifications", () => loadNotifications());
  }
}

export function reconnectRealtime(): void {
  if (typeof EventSource === "undefined") return;
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  const source = new EventSource("/api/events");
  activeEventSource = source;
  source.addEventListener("open", () => {
    setStoreState({ sseConnected: true });
  });
  source.addEventListener("error", () => {
    setStoreState({ sseConnected: false });
    refreshActiveRouteIfStale(15_000);
  });
  const types = [
    "post.created",
    "post.deleted",
    "post.engagement",
    "org.posted",
    "article.published",
    "chat.message",
    "chat.reaction",
    "chat.invite",
    "chat.updated",
    "alpha.invite",
    "notification.created",
    "world.tick",
    "market.clue",
    "market.resolved",
    "market.spot",
    "market.perp",
    "market.prediction",
  ];
  for (const eventType of types) {
    source.addEventListener(eventType, (evt) => {
      const msgEvt = evt as MessageEvent<unknown>;
      handleSseEvent(eventType, msgEvt.data);
    });
  }
}

export function bootStore(): void {
  if (booted) return;
  booted = true;
  registerAuthChangedHook(reconnectRealtime);
  registerNavigateHook(navigate);
  applyDocumentTheme(getStoreSnapshot().theme);
  if (typeof window !== "undefined") {
    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", () => {
        if (getStoreSnapshot().theme === "system") {
          applyDocumentTheme("system");
        }
      });
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          refreshActiveRouteIfStale(5_000);
        }
      });
    }
    window.addEventListener("popstate", () => {
      decrementSpaNavDepth();
      const parsed = parseLocation(window.location.pathname, window.location.search);
      const guard = guardRouteAccess(parsed, `${window.location.pathname}${window.location.search}`);
      if (guard === "blocked_auth") return;
      if (guard === "blocked_redirect") {
        void redirectToHome({ replace: true });
        return;
      }
      sendNav({ type: "navigateTo", targetRoute: parsed.route });
      sendApp({ type: "navigateApp", targetRoute: parsed.route });
      applyParsedLocation(parsed);
      void loadDataForRoute(parsed.route, window.location.search);
    });
    window.addEventListener(
      "scroll",
      () => {
        const s = getStoreSnapshot();
        if (!s.scrolledDeep && s.viewer === null && window.scrollY > 360) {
          sendNav({ type: "scrollFeed" });
          sendApp({ type: "scrollVisitorFeed" });
          setStoreState({ scrolledDeep: true });
        }
      },
      { passive: true },
    );
  }
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  void (async () => {
    await Promise.all([hydrateAuth(), loadSkillsHosts()]);
    reconnectRealtime();
    const afterAuth = getStoreSnapshot();
    if (
      !afterAuth.viewer &&
      afterAuth.localUiMode === "social" &&
      (afterAuth.route === "Markets" || afterAuth.route === "Leaderboard" || afterAuth.walletView)
    ) {
      setStoreState({ route: "Home", walletView: false });
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", "/");
      }
    }
    const route = getStoreSnapshot().route;
    const tasks: Promise<void>[] = [loadDataForRoute(route, initialSearch)];
    if (route !== "Markets" && route !== "Leaderboard") {
      tasks.push(loadWorldStatus());
    }
    if (route !== "Explore" || afterAuth.activeArticleId) {
      tasks.push(loadTrending());
    }
    if (route !== "Markets" && route !== "Leaderboard") {
      if (currentUiMode(afterAuth) === "GameMode") {
        tasks.push(loadMarkets());
      } else {
        tasks.push(loadPositionsSilent());
      }
    }
    if (afterAuth.viewer !== null) {
      if (route !== "Notifications") tasks.push(loadNotifications());
      if (route !== "Chats") tasks.push(loadChats(false));
    }
    await Promise.all(tasks);
  })();
}

function subscribeWithBoot(listener: () => void): () => void {
  bootStore();
  return subscribeStore(listener);
}

export function useAppStore() {
  return useSyncExternalStore(subscribeWithBoot, getStoreSnapshot, getStoreSnapshot);
}

function navigateTargetUrl(target: string): void {
  try {
    const parsed = new URL(target, typeof window !== "undefined" ? window.location.origin : "https://feed.local");
    void navigate(`${parsed.pathname}${parsed.search}`);
  } catch {
    void navigate(target);
  }
}

function openPredictionQuickTrade(marketId: string, side: "yes" | "no"): void {
  if (!getStoreSnapshot().viewer) {
    openJoinSheet();
    return;
  }
  void navigate(`/markets/predictions/${encodeURIComponent(marketId)}?side=${encodeURIComponent(side)}`);
}

export const storeActions = {
  navigate,
  openExploreNews,
  navigateTargetUrl,
  openPredictionQuickTrade,
  navigateRoute,
  hasInternalBackHistory,
  setSettingsTab,
  setExploreUrlQuery,
  setTheme: setThemePreference,
  cycleTheme: cycleThemePreference,
  pushToast,
  dismissToast,
  reconnectRealtime,
  openComposeDialog,
  closeComposeDialog,
  openReportDialog,
  closeReportDialog,
  openBlockDialog,
  closeBlockDialog,
  openMuteDialog,
  closeMuteDialog,
  openDeletePostDialog,
  closeDeletePostDialog,
  loadFeed,
  flushPendingNewPosts,
  loadMoreFeed,
  selectFeedTab,
  openThread,
  closeThread,
  loadArticle,
  createPost,
  deletePost,
  toggleLike,
  repostPost,
  loadExplore,
  loadTrending,
  loadTrendingTag,
  searchAccounts,
  loadMarkets,
  loadMarketDetails,
  setMarketTimeRange,
  loadClosedPositions,
  loadPnlHistory,
  loadWorldStatus,
  loadLeaderboard,
  jumpToMyLeaderboardRank,
  loadEconomy,
  selectMarket,
  openMarketsDashboard,
  toggleWatchlistItem,
  previewPerpOrder,
  submitPredictionOrder,
  submitPerpOrder,
  rebalancePerpPosition,
  closePerpPosition,
  loadChats,
  loadChatMessages,
  markChatRead,
  selectChat,
  startDirectChat,
  createGroupChat,
  inviteToGroupChat,
  leaveGroupChat,
  renameGroupChat,
  removeGroupMember,
  transferGroupOwnership,
  deleteGroupChat,
  sendChatMessage,
  reactToChatMessage,
  respondGroupInvite,
  loadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
  loadProfile,
  loadProfileReplies,
  loadProfileLikes,
  loadProfileTrades,
  loadMoreProfilePosts,
  loadFollowList,
  closeFollowList,
  loadModerationLists,
  updateOwnProfile,
  toggleFollow,
  toggleBlock,
  toggleMute,
  submitReport,
  openJoinSheet,
  setJoinSheetOpen,
  setJoinTab,
  setJoinEmailStep,
  setJoinPhoneStep,
  requestEmailMagicLink,
  resendEmailMagicLink,
  verifyEmailMagicLink,
  completeEmailOnboard,
  startEmailLink,
  requestSmsCode,
  resendSmsCode,
  verifySmsCode,
  completePhoneOnboard,
  submitReviewerLogin,
  setPlayMode,
  toggleUiModeFromControl,
  dismissExplainer,
  dismissBottomBanner,
  copySkillPrompt,
  launchAgentHost,
  revokeAgentGrant,
  fetchLoopbackCode,
  formatPhoneToE164,
  startPhoneChange,
  confirmPhoneChange,
  logout,
  signOutEverywhere,
  deleteAccount,
  loadOAuthConsent,
  submitOAuthDecision,
  lookupDeviceCode,
  approveDeviceCode,
  loadAdminStatus,
  loadAdminReports,
  adminResolveReport,
  loadAdminUsers,
  loadAdminWorldFacts,
  adminCreateWorldFact,
  adminDeleteWorldFact,
  adminFastForward,
  adminRunCron,
  adminResolveHold,
  clearNotices,
};

export { navRuntime };
