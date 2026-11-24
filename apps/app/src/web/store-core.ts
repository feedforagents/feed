// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import type { AgentHostId, ChatMessageItem, JoinPhoneStep, JoinTab, LeaderboardEntry, UiMode } from "@repo/ui";
import { ManagedRuntime } from "effect";
import { routeAccessible, type AppRoute, type FeedTab as SpecFeedTab } from "../../gen/app__navigation.ts";
import { type Event as AppEvent } from "../../gen/app.ts";
import { type Event as NavEvent } from "../../gen/app__navigation.ts";
import { type Event as OnboardingEvent } from "../../gen/app__onboarding.ts";
import {
  appLayer,
  dispatchApp,
  dispatchNav,
  dispatchOnboarding,
  navLayer,
  onboardingLayer,
} from "./machines.vibe";
import { parseLocation, routeToPath, toPublicTarget } from "./routes.ts";
import {
  type AdminStatusData,
  type AppAlphaInvite,
  type AppChatSummary,
  type AppNotification,
  type AppPerpMarket,
  type AppPointPack,
  type AppPosition,
  type AppPost,
  type AppPredictionMarket,
  type AppProfileBundle,
  type AppSkillsPayload,
  type ExploreData,
  type OAuthConsentInfo,
  type PendingAction,
  type PostThreadData,
  type ViewerSession,
  decodeSkillHosts,
} from "./types.ts";

export const appRuntime = ManagedRuntime.make(appLayer);
export const navRuntime = ManagedRuntime.make(navLayer);
export const onboardingRuntime = ManagedRuntime.make(onboardingLayer);

export type UiFeedTab = "latest" | "following" | "top";

export interface StoreState {
  readonly authLoaded: boolean;
  readonly viewer: ViewerSession | null;
  readonly acceptedCountries: ReadonlyArray<string>;
  readonly publicAppUrl: string;
  readonly turnstileSiteKey: string | null;
  readonly devSmsCodeEnabled: boolean;
  readonly route: AppRoute;
  readonly profileHandle: string | null;
  readonly selectedTicker: string | null;
  readonly feedTab: UiFeedTab;
  readonly localUiMode: "game" | "social";
  readonly bannerDismissed: boolean;
  readonly explainerDismissed: boolean;
  readonly scrolledDeep: boolean;
  readonly itemsViewed: number;
  readonly statusMessage: string | null;
  readonly errorMessage: string | null;
  readonly joinSheetOpen: boolean;
  readonly joinTab: JoinTab;
  readonly joinPhoneStep: JoinPhoneStep;
  readonly joinLoading: boolean;
  readonly joinError: string | null;
  readonly pendingPhoneE164: string;
  readonly pendingOnboardingToken: string;
  readonly pendingAction: PendingAction | null;
  readonly feedLoading: boolean;
  readonly feedLoadingMore: boolean;
  readonly feedPosts: ReadonlyArray<AppPost>;
  readonly feedNextCursor: string | null;
  readonly activeThread: PostThreadData | null;
  readonly threadLoading: boolean;
  readonly exploreQuery: string;
  readonly exploreLoading: boolean;
  readonly explore: ExploreData;
  readonly marketsLoading: boolean;
  readonly predictions: ReadonlyArray<AppPredictionMarket>;
  readonly perps: ReadonlyArray<AppPerpMarket>;
  readonly positions: ReadonlyArray<AppPosition>;
  readonly selectedMarketKind: "prediction" | "perp";
  readonly selectedMarketId: string | null;
  readonly leaderboard: ReadonlyArray<LeaderboardEntry>;
  readonly packs: ReadonlyArray<AppPointPack>;
  readonly tradeLoading: boolean;
  readonly tradeError: string | null;
  readonly checkoutLoading: boolean;
  readonly checkoutError: string | null;
  readonly chatsLoading: boolean;
  readonly chats: ReadonlyArray<AppChatSummary>;
  readonly selectedChatId: string | null;
  readonly chatMessages: ReadonlyArray<ChatMessageItem>;
  readonly alphaInvites: ReadonlyArray<AppAlphaInvite>;
  readonly chatSending: boolean;
  readonly notificationsLoading: boolean;
  readonly notifications: ReadonlyArray<AppNotification>;
  readonly unreadNotifications: number;
  readonly profileLoading: boolean;
  readonly profileLoadingMore: boolean;
  readonly profileBundle: AppProfileBundle | null;
  readonly skills: AppSkillsPayload;
  readonly hostActionNote: string | null;
  readonly oauthConsent: OAuthConsentInfo | null;
  readonly oauthLoading: boolean;
  readonly oauthError: string | null;
  readonly linkStatus: string | null;
  readonly linkError: string | null;
  readonly linkLoading: boolean;
  readonly adminStatus: AdminStatusData | null;
  readonly adminLoading: boolean;
  readonly adminMessage: string | null;
}

const EXPLAINER_STORAGE_KEY = "feed:explainer-dismissed";

function readExplainerDismissed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(EXPLAINER_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistExplainerDismissed(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(EXPLAINER_STORAGE_KEY, "1");
    }
  } catch {
    return;
  }
}

const UI_MODE_STORAGE_KEY = "feed:ui-mode";

export function readStoredUiMode(): "game" | "social" {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(UI_MODE_STORAGE_KEY) === "social") {
      return "social";
    }
  } catch {
    return "game";
  }
  return "game";
}

export function persistUiMode(mode: "game" | "social"): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
    }
  } catch {
    return;
  }
}

const initialLocation = typeof window !== "undefined"
  ? parseLocation(window.location.pathname, window.location.search)
  : parseLocation("/", "");

let currentState: StoreState = {
  authLoaded: false,
  viewer: null,
  acceptedCountries: ["+1", "+44", "+353", "+61", "+64"],
  publicAppUrl: typeof window !== "undefined" ? window.location.origin : "https://feed.fun",
  turnstileSiteKey: null,
  devSmsCodeEnabled: false,
  route: initialLocation.route,
  profileHandle: initialLocation.profileHandle,
  selectedTicker: initialLocation.queryTicker,
  feedTab: "latest",
  localUiMode: readStoredUiMode(),
  bannerDismissed: false,
  explainerDismissed: readExplainerDismissed(),
  scrolledDeep: false,
  itemsViewed: 0,
  statusMessage: null,
  errorMessage: null,
  joinSheetOpen: false,
  joinTab: "phone",
  joinPhoneStep: "entry",
  joinLoading: false,
  joinError: null,
  pendingPhoneE164: "",
  pendingOnboardingToken: "",
  pendingAction: null,
  feedLoading: false,
  feedLoadingMore: false,
  feedPosts: [],
  feedNextCursor: null,
  activeThread: null,
  threadLoading: false,
  exploreQuery: "",
  exploreLoading: false,
  explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [] },
  marketsLoading: false,
  predictions: [],
  perps: [],
  positions: [],
  selectedMarketKind: initialLocation.queryTicker ? "perp" : "prediction",
  selectedMarketId: initialLocation.queryTicker,
  leaderboard: [],
  packs: [],
  tradeLoading: false,
  tradeError: null,
  checkoutLoading: false,
  checkoutError: null,
  chatsLoading: false,
  chats: [],
  selectedChatId: null,
  chatMessages: [],
  alphaInvites: [],
  chatSending: false,
  notificationsLoading: false,
  notifications: [],
  unreadNotifications: 0,
  profileLoading: false,
  profileLoadingMore: false,
  profileBundle: null,
  skills: decodeSkillHosts(null),
  hostActionNote: null,
  oauthConsent: null,
  oauthLoading: false,
  oauthError: null,
  linkStatus: null,
  linkError: null,
  linkLoading: false,
  adminStatus: null,
  adminLoading: false,
  adminMessage: null,
};

const listeners = new Set<() => void>();
let pendingActionSeq = 0;

export function getStoreSnapshot(): StoreState {
  return currentState;
}

export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setStoreState(patch: Partial<StoreState>): void {
  currentState = { ...currentState, ...patch };
  for (const listener of listeners) listener();
}

export function clearNotices(): void {
  if (currentState.statusMessage !== null || currentState.errorMessage !== null) {
    setStoreState({ statusMessage: null, errorMessage: null });
  }
}

export function currentUiMode(s: StoreState = currentState): UiMode {
  const mode = s.viewer ? s.viewer.uiMode : s.localUiMode;
  return mode === "social" ? "SocialMode" : "GameMode";
}

export function sendApp(event: AppEvent): void {
  void appRuntime.runPromise(dispatchApp(event));
}

export function sendNav(event: NavEvent): void {
  void navRuntime.runPromise(dispatchNav(event));
}

export function sendOnboarding(event: OnboardingEvent): void {
  void onboardingRuntime.runPromise(dispatchOnboarding(event));
}

export function toSpecTab(tab: UiFeedTab): SpecFeedTab {
  if (tab === "following") return "TabFollowing";
  if (tab === "top") return "TabForYou";
  return "TabLatest";
}

export function toSpecGatedKind(action: PendingAction["kind"]) {
  switch (action) {
    case "like":
      return "GatedLike" as const;
    case "repost":
      return "GatedRepost" as const;
    case "reply":
      return "GatedReply" as const;
    case "post":
      return "GatedPost" as const;
    case "follow":
      return "GatedFollow" as const;
    case "dm":
      return "GatedDm" as const;
    case "trade_prediction":
    case "trade_perp":
      return "GatedTrade" as const;
    case "persist_mode":
    case "switch_tab":
      return "GatedPersistMode" as const;
  }
}

export function requireAuthOrQueue(action: PendingAction): boolean {
  if (currentState.viewer !== null) return true;
  pendingActionSeq += 1;
  const specKind = toSpecGatedKind(action.kind);
  sendOnboarding({ type: "triggerGatedAction", actionKind: specKind, targetId: pendingActionSeq });
  sendApp({ type: "triggerAppGatedAction", actionKind: specKind, targetId: pendingActionSeq });
  setStoreState({
    pendingAction: action,
    joinSheetOpen: true,
    joinTab: "phone",
    joinPhoneStep: "entry",
    joinError: null,
  });
  return false;
}

export function pushBrowserRoute(route: AppRoute, profileHandle?: string | null, search = ""): void {
  const nextPath = `${routeToPath(route, profileHandle)}${search}`;
  if (typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
  }
}

export function canEnterRoute(route: AppRoute): boolean {
  const mode = currentUiMode();
  const signedIn = currentState.viewer !== null;
  const isAdmin = currentState.viewer?.isAdmin ?? false;
  return routeAccessible(
    {
      route: currentState.route,
      feedTab: toSpecTab(currentState.feedTab),
      uiMode: mode,
      signedIn,
      isAdmin,
      loginModalOpenOnLoad: false,
      scrolledDeep: currentState.scrolledDeep,
      itemsViewed: currentState.itemsViewed,
      bannerDismissed: currentState.bannerDismissed,
      hasAtRiskOpenPositions: currentState.positions.length > 0,
      lastPublicTarget: "ViewFeed",
    },
    route,
  );
}

export function recordPublicView(route: AppRoute): void {
  const target = toPublicTarget(route);
  if (!target || currentState.viewer !== null) return;
  sendNav({ type: "viewPublicContent", target });
  sendApp({ type: "viewFeedItem", target });
  setStoreState({ itemsViewed: currentState.itemsViewed + 1 });
}

export function buildHostActionNote(hostId: AgentHostId): string {
  const found = currentState.skills.hosts.find((h) => h.launcher.id === hostId);
  if (!found) return "Copied Feed SKILL.md setup prompt.";
  if (found.cliCommand) return `Copied prompt & CLI for ${found.launcher.label}: ${found.cliCommand}`;
  if (found.notes) return `${found.launcher.label}: ${found.notes}`;
  return `Copied Feed SKILL.md prompt for ${found.launcher.label}.`;
}
