// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useSyncExternalStore } from "react";
import type { AppRoute } from "../../gen/app__navigation.ts";
import { parseLocation, routeToPath } from "./routes.ts";
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
  canEnterRoute,
  clearNotices,
  getStoreSnapshot,
  navRuntime,
  onboardingRuntime,
  pushBrowserRoute,
  recordPublicView,
  sendApp,
  sendNav,
  setStoreState,
  subscribeStore,
} from "./store-core.ts";
import {
  closePerpPosition,
  closeThread,
  createGroupChat,
  createPost,
  deletePost,
  inviteToGroupChat,
  leaveGroupChat,
  loadChatMessages,
  loadChats,
  selectChat,
  loadExplore,
  loadFeed,
  loadMarkets,
  loadMoreFeed,
  loadMoreProfilePosts,
  loadNotifications,
  loadProfile,
  loadTrending,
  markAllNotificationsRead,
  openThread,
  reactToChatMessage,
  repostPost,
  respondAlphaInvite,
  selectFeedTab,
  selectMarket,
  sendChatMessage,
  startDirectChat,
  startPointPackCheckout,
  submitPerpOrder,
  submitPredictionOrder,
  submitReport,
  toggleBlock,
  toggleFollow,
  toggleLike,
  toggleMute,
  updateOwnProfile,
} from "./store-world.ts";

let booted = false;
let sseRefreshPending = false;

async function loadDataForRoute(route: AppRoute, search = ""): Promise<void> {
  switch (route) {
    case "Home":
      await loadFeed();
      return;
    case "Explore":
      await loadExplore();
      return;
    case "Markets":
      await loadMarkets();
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
  if (!canEnterRoute(parsed.route) && parsed.route !== "OAuthConsent") {
    const s = getStoreSnapshot();
    if (s.viewer === null && (parsed.route === "Chats" || parsed.route === "Notifications" || parsed.route === "Settings")) {
      openJoinSheet("phone");
      return;
    }
    pushBrowserRoute("Home");
    sendNav({ type: "navigateTo", targetRoute: "Home" });
    sendApp({ type: "navigateApp", targetRoute: "Home" });
    setStoreState({ route: "Home", profileHandle: null });
    await loadFeed();
    return;
  }
  if (typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== parsed.pathWithSearch) {
      window.history.pushState(null, "", parsed.pathWithSearch);
    }
  }
  sendNav({ type: "navigateTo", targetRoute: parsed.route });
  sendApp({ type: "navigateApp", targetRoute: parsed.route });
  recordPublicView(parsed.route);
  setStoreState({
    route: parsed.route,
    profileHandle: parsed.profileHandle,
    selectedTicker: parsed.queryTicker,
    ...(parsed.queryTicker ? { selectedMarketKind: "perp" as const, selectedMarketId: parsed.queryTicker } : {}),
  });
  await loadDataForRoute(parsed.route, url.search);
}

export function navigateRoute(route: AppRoute): void {
  const s = getStoreSnapshot();
  const handle = route === "Profile" ? s.viewer?.handle ?? s.profileHandle : null;
  void navigate(routeToPath(route, handle));
}

function handleSseSignal(eventType: string): void {
  if (sseRefreshPending) return;
  sseRefreshPending = true;
  const s = getStoreSnapshot();
  const refresh = async () => {
    try {
      if (eventType.startsWith("post.") && s.route === "Home") {
        await loadFeed();
      } else if (eventType.startsWith("market.") || eventType === "world.tick") {
        if (s.route === "Markets") await loadMarkets();
        if (s.route === "Explore") await loadExplore();
        if (s.route === "Home") await loadFeed();
        if (s.route === "Profile") await loadProfile();
        if (s.viewer) await hydrateAuth();
      } else if (eventType.startsWith("chat.") || eventType === "alpha.invite") {
        if (s.viewer) await loadChats(s.route === "Chats");
      } else if (eventType === "notification.created") {
        if (s.viewer) await loadNotifications();
      }
    } finally {
      sseRefreshPending = false;
    }
  };
  void refresh();
}

function connectRealtime(): void {
  if (typeof EventSource === "undefined") return;
  const source = new EventSource("/api/events");
  const types = [
    "post.created",
    "post.deleted",
    "post.engagement",
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
  ];
  for (const eventType of types) {
    source.addEventListener(eventType, () => handleSseSignal(eventType));
  }
}

export function bootStore(): void {
  if (booted) return;
  booted = true;
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      const parsed = parseLocation(window.location.pathname, window.location.search);
      sendNav({ type: "navigateTo", targetRoute: parsed.route });
      sendApp({ type: "navigateApp", targetRoute: parsed.route });
      setStoreState({
        route: parsed.route,
        profileHandle: parsed.profileHandle,
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
  connectRealtime();
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  void (async () => {
    await Promise.all([hydrateAuth(), loadSkillsHosts()]);
    const afterAuth = getStoreSnapshot();
    const tasks: Promise<void>[] = [loadDataForRoute(afterAuth.route, initialSearch)];
    if (afterAuth.route !== "Explore") {
      tasks.push(loadTrending());
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
  loadFeed,
  loadMoreFeed,
  selectFeedTab,
  openThread,
  closeThread,
  createPost,
  deletePost,
  toggleLike,
  repostPost,
  loadExplore,
  loadTrending,
  loadMarkets,
  selectMarket,
  submitPredictionOrder,
  submitPerpOrder,
  closePerpPosition,
  startPointPackCheckout,
  loadChats,
  loadChatMessages,
  selectChat,
  startDirectChat,
  createGroupChat,
  inviteToGroupChat,
  leaveGroupChat,
  sendChatMessage,
  reactToChatMessage,
  respondAlphaInvite,
  loadNotifications,
  markAllNotificationsRead,
  loadProfile,
  loadMoreProfilePosts,
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
