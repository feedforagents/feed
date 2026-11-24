// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useSyncExternalStore } from "react";
import type { AppRoute } from "../../gen/app__navigation.ts";
import { type SettingsTabId, parseLocation, routeToPath } from "./routes.ts";
import {
  adminFastForward,
  adminResolveHold,
  adminRunCron,
  approveDeviceCode,
  completePhoneOnboard,
  confirmPhoneChange,
  copySkillPrompt,
  deleteAccount,
  dismissBottomBanner,
  dismissExplainer,
  fetchLoopbackCode,
  hydrateAuth,
  launchAgentHost,
  loadAdminStatus,
  loadOAuthConsent,
  loadSkillsHosts,
  logout,
  openJoinSheet,
  requestSmsCode,
  resendSmsCode,
  revokeAgentGrant,
  setJoinPhoneStep,
  setJoinSheetOpen,
  setJoinTab,
  setPlayMode,
  signOutEverywhere,
  startPhoneChange,
  submitOAuthDecision,
  submitReviewerLogin,
  toggleUiModeFromControl,
  verifySmsCode,
} from "./store-auth.ts";
import {
  appRuntime,
  applyDocumentTheme,
  canEnterRoute,
  clearNotices,
  closeBlockDialog,
  closeComposeDialog,
  closeDeletePostDialog,
  closeMuteDialog,
  closeReportDialog,
  currentUiMode,
  cycleThemePreference,
  dismissToast,
  getStoreSnapshot,
  navRuntime,
  onboardingRuntime,
  openBlockDialog,
  openComposeDialog,
  openDeletePostDialog,
  openMuteDialog,
  openReportDialog,
  pushBrowserRoute,
  pushToast,
  recordPublicView,
  registerAuthChangedHook,
  sendApp,
  sendNav,
  setStoreState,
  setThemePreference,
  subscribeStore,
} from "./store-core.ts";
import {
  closeFollowList,
  closePerpPosition,
  closeThread,
  createGroupChat,
  createPost,
  deletePost,
  flushPendingNewPosts,
  inviteToGroupChat,
  leaveGroupChat,
  loadArticle,
  loadChatMessages,
  loadChats,
  loadEconomy,
  loadExplore,
  loadFeed,
  loadFollowList,
  loadLeaderboard,
  loadMarkets,
  loadModerationLists,
  loadMoreFeed,
  loadMoreProfilePosts,
  loadNotifications,
  loadPositionsSilent,
  loadProfile,
  loadTrending,
  loadTrendingTag,
  markAllNotificationsRead,
  markChatRead,
  markNotificationRead,
  openThread,
  patchPostCardAcrossStore,
  reactToChatMessage,
  removePostAcrossStore,
  repostPost,
  respondAlphaInvite,
  searchAccounts,
  selectFeedTab,
  selectMarket,
  sendChatMessage,
  startDirectChat,
  submitPerpOrder,
  submitPredictionOrder,
  submitReport,
  toggleBlock,
  toggleFollow,
  toggleLike,
  toggleMute,
  updateOwnProfile,
} from "./store-world.ts";
import { isRecord, num, optStr } from "./types.ts";

type SseDomain = "feed" | "markets" | "explore" | "profile" | "chats" | "notifications" | "auth";

let booted = false;
let activeEventSource: EventSource | null = null;
const sseDomainInFlight = new Set<SseDomain>();

async function runDomainRefresh(domain: SseDomain, task: () => Promise<void>): Promise<void> {
  if (sseDomainInFlight.has(domain)) return;
  sseDomainInFlight.add(domain);
  try {
    await task();
  } finally {
    sseDomainInFlight.delete(domain);
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
    case "Markets":
      await loadMarkets();
      if (s.walletView && s.viewer) await loadEconomy();
      return;
    case "Leaderboard":
      await loadLeaderboard();
      return;
    case "Chats":
      await loadChats();
      return;
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
    case "Admin":
      await loadAdminStatus();
      return;
    case "Link":
      return;
  }
}

export async function navigate(path: string): Promise<void> {
  const url = new URL(path, "https://feed.local");
  const parsed = parseLocation(url.pathname, url.search);
  clearNotices();
  const mode = currentUiMode();
  const blockedInSocial = mode === "SocialMode" && (parsed.route === "Markets" || parsed.route === "Leaderboard" || parsed.walletView);
  if ((!canEnterRoute(parsed.route) || blockedInSocial) && parsed.route !== "OAuthConsent") {
    const s = getStoreSnapshot();
    if (s.viewer === null && (parsed.route === "Chats" || parsed.route === "Notifications" || parsed.route === "Settings")) {
      openJoinSheet("phone");
      return;
    }
    pushBrowserRoute("Home");
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
    await loadFeed();
    return;
  }
  if (typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== parsed.canonicalPath) {
      if (parsed.replaceCanonical) {
        window.history.replaceState(null, "", parsed.canonicalPath);
      } else {
        window.history.pushState(null, "", parsed.canonicalPath);
      }
    }
  }
  sendNav({ type: "navigateTo", targetRoute: parsed.route });
  sendApp({ type: "navigateApp", targetRoute: parsed.route });
  recordPublicView(parsed.route);
  setStoreState({
    route: parsed.route,
    profileHandle: parsed.profileHandle,
    activePostId: parsed.postId,
    activeArticleId: parsed.articleId,
    activeTrendingTag: parsed.trendingTag,
    walletView: parsed.walletView,
    ...(parsed.exploreQuery !== null ? { exploreQuery: parsed.exploreQuery } : {}),
    ...(parsed.settingsTab ? { settingsTab: parsed.settingsTab } : {}),
    selectedTicker: parsed.queryTicker,
    ...(parsed.marketKind && parsed.marketId
      ? { selectedMarketKind: parsed.marketKind, selectedMarketId: parsed.marketId }
      : parsed.queryTicker
        ? { selectedMarketKind: "perp" as const, selectedMarketId: parsed.queryTicker }
        : {}),
  });
  await loadDataForRoute(parsed.route, url.search);
}

export function navigateRoute(route: AppRoute): void {
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

function handleSseEvent(eventType: string, rawData: unknown): void {
  const data = parseSseData(rawData);
  const s = getStoreSnapshot();

  if (eventType === "post.engagement" && data) {
    const postId = optStr(data.postId);
    if (postId) {
      const likeCount = typeof data.likeCount === "number" ? data.likeCount : undefined;
      const repostCount = typeof data.repostCount === "number" ? data.repostCount : undefined;
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        ...(likeCount !== undefined ? { likeCount } : {}),
        ...(repostCount !== undefined ? { repostCount } : {}),
      }));
    }
    return;
  }

  if (eventType === "post.deleted" && data) {
    const postId = optStr(data.postId);
    if (postId) {
      removePostAcrossStore(postId);
    }
    return;
  }

  if (eventType === "post.created" || eventType === "org.posted") {
    const replyToPostId = data ? optStr(data.replyToPostId) : null;
    if (s.route === "PostDetail" && s.activePostId && replyToPostId === s.activePostId) {
      void runDomainRefresh("feed", () => openThread(s.activePostId ?? "", s.threadSort));
      return;
    }
    if (s.route === "Home") {
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
    void runDomainRefresh("explore", () => (s.route === "Explore" ? loadExplore() : loadTrending()));
    return;
  }

  if (eventType.startsWith("market.") || eventType === "world.tick") {
    if (s.route === "Markets" || s.route === "Leaderboard") {
      void runDomainRefresh("markets", () => (s.route === "Leaderboard" ? loadLeaderboard() : loadMarkets()));
    }
    if (s.route === "Explore") {
      void runDomainRefresh("explore", () => loadExplore());
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
      if (s.route === "Chats" && chatId && chatId === s.selectedChatId) {
        await Promise.all([loadChats(false), loadChatMessages(chatId)]);
      } else {
        await loadChats(s.route === "Chats");
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
    window.addEventListener("popstate", () => {
      const parsed = parseLocation(window.location.pathname, window.location.search);
      sendNav({ type: "navigateTo", targetRoute: parsed.route });
      sendApp({ type: "navigateApp", targetRoute: parsed.route });
      setStoreState({
        route: parsed.route,
        profileHandle: parsed.profileHandle,
        activePostId: parsed.postId,
        activeArticleId: parsed.articleId,
        activeTrendingTag: parsed.trendingTag,
        walletView: parsed.walletView,
        ...(parsed.exploreQuery !== null ? { exploreQuery: parsed.exploreQuery } : {}),
        ...(parsed.settingsTab ? { settingsTab: parsed.settingsTab } : {}),
        selectedTicker: parsed.queryTicker,
      });
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
    const tasks: Promise<void>[] = [loadDataForRoute(afterAuth.route, initialSearch)];
    if (afterAuth.route !== "Explore") {
      tasks.push(loadTrending());
    }
    if (afterAuth.route !== "Markets" && afterAuth.route !== "Leaderboard") {
      tasks.push(loadPositionsSilent());
    }
    if (afterAuth.viewer !== null) {
      if (afterAuth.route !== "Notifications") tasks.push(loadNotifications());
      if (afterAuth.route !== "Chats") tasks.push(loadChats(false));
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

export const storeActions = {
  navigate,
  navigateRoute,
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
  loadLeaderboard,
  loadEconomy,
  selectMarket,
  submitPredictionOrder,
  submitPerpOrder,
  closePerpPosition,
  loadChats,
  loadChatMessages,
  markChatRead,
  startDirectChat,
  createGroupChat,
  inviteToGroupChat,
  leaveGroupChat,
  sendChatMessage,
  reactToChatMessage,
  respondAlphaInvite,
  loadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  loadProfile,
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
  setJoinPhoneStep,
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
  startPhoneChange,
  confirmPhoneChange,
  logout,
  signOutEverywhere,
  deleteAccount,
  loadOAuthConsent,
  submitOAuthDecision,
  approveDeviceCode,
  loadAdminStatus,
  adminFastForward,
  adminRunCron,
  adminResolveHold,
  clearNotices,
};

export { appRuntime, navRuntime, onboardingRuntime };
