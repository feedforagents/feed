// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import type {
  AgentHostId,
  AssetTradeEntry,
  ChatMessageItem,
  JoinEmailStep,
  JoinPhoneStep,
  JoinTab,
  LeaderboardAudienceFilter,
  LeaderboardMetric,
  LeaderboardScope,
  LeaderboardTimeframe,
  LightweightChartPoint,
  MarketTimeRange,
  ToastTone,
  TrendingItem,
  UiMode,
  WalletClosedPosition,
} from "@repo/ui";
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
import { type SettingsTabId, parseLocation, routeToPath, toPublicTarget } from "./routes.ts";
import {
  type AdminReportRow,
  type AdminStatusData,
  type AdminUserRow,
  type AdminWorldFactRow,
  type AppAccountEconomy,
  type AppAlphaInvite,
  type AppArticle,
  type AppChatSummary,
  type AppFollowListEntry,
  type AppLeaderboardEntry,
  type AppLedgerEntry,
  type AppMarketHistoryPoint,
  type AppModerationEntry,
  type AppNotification,
  type AppPerpMarket,
  type AppPerpPreview,
  type AppPosition,
  type AppPost,
  type AppPredictionMarket,
  type AppProfileBundle,
  type AppSkillsPayload,
  type AppWorldStatus,
  type DeviceLookupInfo,
  type ExploreData,
  type OAuthConsentInfo,
  type PendingAction,
  type PostThreadData,
  type ThemePreference,
  type ToastItem,
  type ViewerSession,
  decodeSkillHosts,
  isRecord,
} from "./types.ts";

export const appRuntime = ManagedRuntime.make(appLayer);
export const navRuntime = ManagedRuntime.make(navLayer);
export const onboardingRuntime = ManagedRuntime.make(onboardingLayer);

export type UiFeedTab = "latest" | "following" | "top";

export type ThreadReplySort = "popular" | "newest" | "oldest";

export interface GlobalReportTarget {
  readonly kind: "post" | "account";
  readonly id: string;
  readonly label: string;
}

export interface GlobalAccountActionTarget {
  readonly handle: string;
  readonly currentlyActive: boolean;
}

export type EmailVerifyStatus = "idle" | "verifying" | "needs_onboarding" | "signed_in" | "linked" | "error";

export type ComposeSession = { readonly quotePost: AppPost | null };

export interface StoreState {
  readonly authLoaded: boolean;
  readonly viewer: ViewerSession | null;
  readonly acceptedCountries: ReadonlyArray<string>;
  readonly publicAppUrl: string;
  readonly turnstileSiteKey: string | null;
  readonly devSmsCodeEnabled: boolean;
  readonly emailAuthEnabled: boolean;
  readonly devEmailLinkEnabled: boolean;
  readonly route: AppRoute;
  readonly profileHandle: string | null;
  readonly activePostId: string | null;
  readonly activeArticleId: string | null;
  readonly activeArticle: AppArticle | null;
  readonly articleLoading: boolean;
  readonly activeTrendingTag: string | null;
  readonly exploreNewsRequest: number | null;
  readonly walletView: boolean;
  readonly settingsTab: SettingsTabId;
  readonly selectedTicker: string | null;
  readonly feedTab: UiFeedTab;
  readonly localUiMode: "game" | "social";
  readonly theme: ThemePreference;
  readonly sseConnected: boolean;
  readonly bannerDismissed: boolean;
  readonly explainerDismissed: boolean;
  readonly scrolledDeep: boolean;
  readonly itemsViewed: number;
  readonly toasts: ReadonlyArray<ToastItem>;
  readonly statusMessage: string | null;
  readonly errorMessage: string | null;
  readonly joinSheetOpen: boolean;
  readonly joinTab: JoinTab;
  readonly joinEmailStep: JoinEmailStep;
  readonly joinPhoneStep: JoinPhoneStep;
  readonly joinLoading: boolean;
  readonly joinError: string | null;
  readonly pendingEmail: string;
  readonly pendingEmailMasked: string;
  readonly devEmailMagicLinkUrl: string | null;
  readonly emailVerifyStatus: EmailVerifyStatus;
  readonly emailVerifyError: string | null;
  readonly emailVerifyRedirectTo: string | null;
  readonly pendingPhoneE164: string;
  readonly pendingOnboardingToken: string;
  readonly pendingAction: PendingAction | null;
  readonly composeSession: ComposeSession | null;
  readonly reportTarget: GlobalReportTarget | null;
  readonly blockTarget: GlobalAccountActionTarget | null;
  readonly muteTarget: GlobalAccountActionTarget | null;
  readonly deletePostTargetId: string | null;
  readonly feedLoading: boolean;
  readonly feedLoadingMore: boolean;
  readonly feedPosts: ReadonlyArray<AppPost>;
  readonly feedNextCursor: string | null;
  readonly pendingNewPostCount: number;
  readonly activeThread: PostThreadData | null;
  readonly threadSort: ThreadReplySort;
  readonly threadLoading: boolean;
  readonly exploreQuery: string;
  readonly exploreLoading: boolean;
  readonly trendingLoading: boolean;
  readonly explore: ExploreData;
  readonly rightRailTrending: ReadonlyArray<TrendingItem>;
  readonly rightRailArticles: ReadonlyArray<AppArticle>;
  readonly marketsLoading: boolean;
  readonly marketsViewMode: "dashboard" | "terminal";
  readonly predictions: ReadonlyArray<AppPredictionMarket>;
  readonly perps: ReadonlyArray<AppPerpMarket>;
  readonly positions: ReadonlyArray<AppPosition>;
  readonly closedPositions: ReadonlyArray<WalletClosedPosition>;
  readonly closedPositionsLoading: boolean;
  readonly selectedMarketKind: "prediction" | "perp";
  readonly selectedMarketId: string | null;
  readonly selectedMarketSide: "YES" | "NO";
  readonly marketSideIntentSeq: number;
  readonly marketHistory: ReadonlyArray<AppMarketHistoryPoint>;
  readonly marketHistoryLoading: boolean;
  readonly marketTrades: ReadonlyArray<AssetTradeEntry>;
  readonly marketTradesLoading: boolean;
  readonly marketSocialPosts: ReadonlyArray<AppPost>;
  readonly marketTimeRange: MarketTimeRange;
  readonly watchlist: ReadonlyArray<string>;
  readonly worldStatus: AppWorldStatus | null;
  readonly perpPreview: AppPerpPreview | null;
  readonly leaderboard: ReadonlyArray<AppLeaderboardEntry>;
  readonly leaderboardAudience: LeaderboardAudienceFilter;
  readonly leaderboardTimeframe: LeaderboardTimeframe;
  readonly leaderboardScope: LeaderboardScope;
  readonly leaderboardMetric: LeaderboardMetric;
  readonly leaderboardPage: number;
  readonly leaderboardTotalPages: number;
  readonly leaderboardTotalCount: number;
  readonly leaderboardCurrentUser: AppLeaderboardEntry | null;
  readonly leaderboardLoading: boolean;
  readonly economy: AppAccountEconomy | null;
  readonly ledger: ReadonlyArray<AppLedgerEntry>;
  readonly economyLoading: boolean;
  readonly pnlTimeRange: MarketTimeRange;
  readonly pnlHistory: ReadonlyArray<LightweightChartPoint>;
  readonly pnlHistoryLoading: boolean;
  readonly tradeLoading: boolean;
  readonly tradeError: string | null;
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
  readonly profileReplies: ReadonlyArray<AppPost>;
  readonly profileRepliesLoading: boolean;
  readonly profileLikes: ReadonlyArray<AppPost>;
  readonly profileLikesLoading: boolean;
  readonly profileTrades: ReadonlyArray<AssetTradeEntry>;
  readonly profileTradesLoading: boolean;
  readonly followListKind: "followers" | "following" | null;
  readonly followListHandle: string | null;
  readonly followListItems: ReadonlyArray<AppFollowListEntry>;
  readonly followListLoading: boolean;
  readonly blockedAccounts: ReadonlyArray<AppModerationEntry>;
  readonly mutedAccounts: ReadonlyArray<AppModerationEntry>;
  readonly moderationLoading: boolean;
  readonly skills: AppSkillsPayload;
  readonly hostActionNote: string | null;
  readonly oauthConsent: OAuthConsentInfo | null;
  readonly oauthLoading: boolean;
  readonly oauthError: string | null;
  readonly deviceLookup: DeviceLookupInfo | null;
  readonly deviceLookupLoading: boolean;
  readonly linkStatus: string | null;
  readonly linkError: string | null;
  readonly linkLoading: boolean;
  readonly adminStatus: AdminStatusData | null;
  readonly adminReports: ReadonlyArray<AdminReportRow>;
  readonly adminUsers: ReadonlyArray<AdminUserRow>;
  readonly adminFacts: ReadonlyArray<AdminWorldFactRow>;
  readonly adminTabLoading: boolean;
  readonly adminLoading: boolean;
  readonly adminMessage: string | null;
}

const EXPLAINER_STORAGE_KEY = "feed:explainer-dismissed";
const THEME_STORAGE_KEY = "feed-theme";
const WATCHLIST_STORAGE_KEY = "feed-watchlist";
const LEGACY_FAVORITES_STORAGE_KEY = "feed:market-favorites";
const PENDING_ACTION_STORAGE_KEY = "feed:pending-action";
const PENDING_ACTION_TTL_MS = 20 * 60 * 1000;

export function persistPendingAction(action: PendingAction | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!action) {
      localStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      PENDING_ACTION_STORAGE_KEY,
      JSON.stringify({ savedAt: Date.now(), action }),
    );
  } catch {
    return;
  }
}

export function readPersistedPendingAction(): PendingAction | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(PENDING_ACTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    if (Date.now() - savedAt > PENDING_ACTION_TTL_MS) {
      localStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
      return null;
    }
    if (!isRecord(parsed.action) || typeof parsed.action.kind !== "string") return null;
    return parsed.action as PendingAction;
  } catch {
    return null;
  }
}

export function clearPersistedPendingAction(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PENDING_ACTION_STORAGE_KEY);
    }
  } catch {
    return;
  }
}

function readWatchlist(): ReadonlyArray<string> {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? localStorage.getItem(LEGACY_FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

export function toggleWatchlistItem(kind: "perp" | "prediction", ref: string): void {
  const key = `${kind}:${kind === "perp" ? ref.toUpperCase() : ref}`;
  const current = currentState.watchlist;
  const exists = current.includes(key);
  const next = exists ? current.filter((item) => item !== key) : [...current, key];
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    setStoreState({ watchlist: next });
    return;
  }
  setStoreState({ watchlist: next });
}

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

export function readStoredTheme(): ThemePreference {
  try {
    if (typeof localStorage === "undefined") return "dark";
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    return "dark";
  }
  return "dark";
}

export function applyDocumentTheme(theme: ThemePreference): void {
  if (typeof document === "undefined") return;
  const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
  const useDark = theme === "light" ? false : theme === "system" ? prefersDark : true;
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(useDark ? "dark" : "light");
}

export function setThemePreference(next: ThemePreference): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  } catch {
    applyDocumentTheme(next);
    setStoreState({ theme: next });
    return;
  }
  applyDocumentTheme(next);
  setStoreState({ theme: next });
}

export function cycleThemePreference(): void {
  const cur = getStoreSnapshot().theme;
  const next: ThemePreference = cur === "dark" ? "light" : cur === "light" ? "system" : "dark";
  setThemePreference(next);
}

const initialTheme = readStoredTheme();
applyDocumentTheme(initialTheme);

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

let pendingInitialEmailMagicToken: string | null = initialLocation.emailMagicToken;
let pendingInitialChatId: string | null = initialLocation.chatId;
let spaNavDepth = 0;

export function consumeInitialEmailMagicToken(): string | null {
  const token = pendingInitialEmailMagicToken;
  pendingInitialEmailMagicToken = null;
  return token;
}

export function consumeInitialChatId(): string | null {
  const id = pendingInitialChatId;
  pendingInitialChatId = null;
  return id;
}

export function incrementSpaNavDepth(): void {
  spaNavDepth += 1;
}

export function decrementSpaNavDepth(): void {
  spaNavDepth = Math.max(0, spaNavDepth - 1);
}

export function hasInternalBackHistory(): boolean {
  return spaNavDepth > 0;
}

if (typeof window !== "undefined" && initialLocation.replaceCanonical) {
  window.history.replaceState(null, "", initialLocation.canonicalPath);
}

const initialUiMode = readStoredUiMode();

let currentState: StoreState = {
  authLoaded: false,
  viewer: null,
  acceptedCountries: ["+1", "+44", "+353", "+61", "+64"],
  publicAppUrl: typeof window !== "undefined" ? window.location.origin : "https://feed.fun",
  turnstileSiteKey: null,
  devSmsCodeEnabled: false,
  emailAuthEnabled: true,
  devEmailLinkEnabled: false,
  route: initialLocation.route,
  profileHandle: initialLocation.profileHandle,
  activePostId: initialLocation.postId,
  activeArticleId: initialLocation.articleId,
  activeArticle: null,
  articleLoading: false,
  activeTrendingTag: initialLocation.trendingTag,
  exploreNewsRequest: null,
  walletView: initialLocation.walletView,
  settingsTab: initialLocation.settingsTab ?? "profile",
  selectedTicker: initialLocation.queryTicker,
  feedTab: "latest",
  localUiMode: initialUiMode,
  theme: initialTheme,
  sseConnected: false,
  bannerDismissed: false,
  explainerDismissed: readExplainerDismissed(),
  scrolledDeep: false,
  itemsViewed: 0,
  toasts: [],
  statusMessage: null,
  errorMessage: null,
  joinSheetOpen: false,
  joinTab: "email",
  joinEmailStep: "entry",
  joinPhoneStep: "entry",
  joinLoading: false,
  joinError: null,
  pendingEmail: "",
  pendingEmailMasked: "",
  devEmailMagicLinkUrl: null,
  emailVerifyStatus: "idle",
  emailVerifyError: null,
  emailVerifyRedirectTo: null,
  pendingPhoneE164: "",
  pendingOnboardingToken: "",
  pendingAction: null,
  composeSession: null,
  reportTarget: null,
  blockTarget: null,
  muteTarget: null,
  deletePostTargetId: null,
  feedLoading: true,
  feedLoadingMore: false,
  feedPosts: [],
  feedNextCursor: null,
  pendingNewPostCount: 0,
  activeThread: null,
  threadSort: "popular",
  threadLoading: false,
  exploreQuery: initialLocation.exploreQuery ?? "",
  exploreLoading: false,
  trendingLoading: true,
  explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
  rightRailTrending: [],
  rightRailArticles: [],
  marketsLoading: false,
  marketsViewMode: initialLocation.marketId || initialLocation.queryTicker ? "terminal" : "dashboard",
  predictions: [],
  perps: [],
  positions: [],
  closedPositions: [],
  closedPositionsLoading: false,
  selectedMarketKind: initialLocation.marketKind ?? (initialLocation.queryTicker ? "perp" : "prediction"),
  selectedMarketId: initialLocation.marketId ?? initialLocation.queryTicker,
  selectedMarketSide: initialLocation.marketSide ?? "YES",
  marketSideIntentSeq: 0,
  marketHistory: [],
  marketHistoryLoading: false,
  marketTrades: [],
  marketTradesLoading: false,
  marketSocialPosts: [],
  marketTimeRange: "1D",
  watchlist: readWatchlist(),
  worldStatus: null,
  perpPreview: null,
  leaderboard: [],
  leaderboardAudience: "traders",
  leaderboardTimeframe: "ALL",
  leaderboardScope: "players",
  leaderboardMetric: "net_profit",
  leaderboardPage: 1,
  leaderboardTotalPages: 1,
  leaderboardTotalCount: 0,
  leaderboardCurrentUser: null,
  leaderboardLoading: false,
  economy: null,
  ledger: [],
  economyLoading: false,
  pnlTimeRange: "ALL",
  pnlHistory: [],
  pnlHistoryLoading: false,
  tradeLoading: false,
  tradeError: null,
  chatsLoading: false,
  chats: [],
  selectedChatId: initialLocation.chatId,
  chatMessages: [],
  alphaInvites: [],
  chatSending: false,
  notificationsLoading: false,
  notifications: [],
  unreadNotifications: 0,
  profileLoading: false,
  profileLoadingMore: false,
  profileBundle: null,
  profileReplies: [],
  profileRepliesLoading: false,
  profileLikes: [],
  profileLikesLoading: false,
  profileTrades: [],
  profileTradesLoading: false,
  followListKind: null,
  followListHandle: null,
  followListItems: [],
  followListLoading: false,
  blockedAccounts: [],
  mutedAccounts: [],
  moderationLoading: false,
  skills: decodeSkillHosts(null),
  hostActionNote: null,
  oauthConsent: null,
  oauthLoading: false,
  oauthError: null,
  deviceLookup: null,
  deviceLookupLoading: false,
  linkStatus: null,
  linkError: null,
  linkLoading: false,
  adminStatus: null,
  adminReports: [],
  adminUsers: [],
  adminFacts: [],
  adminTabLoading: false,
  adminLoading: false,
  adminMessage: null,
};

const listeners = new Set<() => void>();
let pendingActionSeq = 0;
let toastSeq = 0;
let onAuthChangedCallback: (() => void) | null = null;
let onNavigateCallback: ((path: string) => Promise<void>) | null = null;

export function registerAuthChangedHook(fn: () => void): void {
  onAuthChangedCallback = fn;
}

export function notifyAuthChanged(): void {
  onAuthChangedCallback?.();
}

export function registerNavigateHook(fn: (path: string) => Promise<void>): void {
  onNavigateCallback = fn;
}

export async function navigateViaHook(path: string): Promise<void> {
  if (onNavigateCallback) {
    await onNavigateCallback(path);
  }
}

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

export function pushToast(message: string, tone: ToastTone = "default", description?: string, replyPostId?: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  toastSeq += 1;
  const item: ToastItem = {
    id: `toast-${toastSeq}`,
    message: trimmed,
    ...(description ? { description } : {}),
    tone,
    ...(replyPostId ? { replyPostId } : {}),
  };
  const deduped = currentState.toasts.filter((t) => t.message !== trimmed || t.tone !== tone || t.replyPostId !== replyPostId);
  setStoreState({ toasts: [...deduped.slice(-3), item] });
}

export function dismissToast(id: string): void {
  setStoreState({ toasts: currentState.toasts.filter((t) => t.id !== id) });
}

export function setStatusNotice(message: string): void {
  pushToast(message, "ok");
  setStoreState({ statusMessage: message });
}

export function setErrorNotice(message: string): void {
  pushToast(message, "destructive");
  setStoreState({ errorMessage: message });
}

export function setReplyErrorNotice(postId: string, message: string): void {
  pushToast(message, "destructive", undefined, postId);
  setStoreState({ errorMessage: message });
}

export function clearReplyFailureNotice(postId: string): void {
  const removed = currentState.toasts.filter((toast) => toast.tone === "destructive" && toast.replyPostId === postId);
  if (removed.length === 0) return;
  const keptToasts = currentState.toasts.filter((toast) => !(toast.tone === "destructive" && toast.replyPostId === postId));
  const errorCleared = currentState.errorMessage !== null && removed.some((toast) => toast.message === currentState.errorMessage);
  setStoreState({ toasts: keptToasts, ...(errorCleared ? { errorMessage: null } : {}) });
}

export function clearNotices(): void {
  if (currentState.statusMessage !== null || currentState.errorMessage !== null) {
    setStoreState({ statusMessage: null, errorMessage: null });
  }
}

export function hasAtRiskOpenPositions(s: StoreState = currentState): boolean {
  return s.positions.some((p) => !p.isClosed);
}

export function currentUiMode(s: StoreState = currentState): UiMode {
  const mode = s.viewer ? s.viewer.uiMode : s.localUiMode;
  return mode === "social" ? "SocialMode" : "GameMode";
}

export function anonymousModeQuery(s: StoreState = currentState): string {
  if (s.viewer !== null) return "";
  return `mode=${currentUiMode(s) === "SocialMode" ? "social" : "game"}`;
}

export function appendAnonymousModeParam(url: string, s: StoreState = currentState): string {
  const q = anonymousModeQuery(s);
  if (!q) return url;
  return url.includes("?") ? `${url}&${q}` : `${url}?${q}`;
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

export function defaultJoinTab(s: StoreState = currentState): JoinTab {
  return s.emailAuthEnabled ? "email" : "phone";
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
    case "navigate":
      return "GatedPersistMode" as const;
  }
}

const CLOSED_DIALOGS: Partial<StoreState> = {
  joinSheetOpen: false,
  followListKind: null,
  composeSession: null,
  reportTarget: null,
  blockTarget: null,
  muteTarget: null,
  deletePostTargetId: null,
};

export function joinSheetOpenPatch(tab?: JoinTab): Partial<StoreState> {
  return {
    ...CLOSED_DIALOGS,
    joinSheetOpen: true,
    joinTab: tab ?? defaultJoinTab(currentState),
    joinEmailStep: "entry",
    joinPhoneStep: "entry",
    joinError: null,
  };
}

export function requireAuthOrQueue(action: PendingAction): boolean {
  if (currentState.viewer !== null) return true;
  pendingActionSeq += 1;
  const specKind = toSpecGatedKind(action.kind);
  sendOnboarding({ type: "triggerGatedAction", actionKind: specKind, targetId: pendingActionSeq });
  sendApp({ type: "triggerAppGatedAction", actionKind: specKind, targetId: pendingActionSeq });
  setStoreState({
    ...joinSheetOpenPatch(),
    pendingAction: action,
  });
  return false;
}

export function pushBrowserRoute(
  route: AppRoute,
  options?: { readonly profileHandle?: string | null; readonly postId?: string | null; readonly articleId?: string | null; readonly walletView?: boolean },
  search = "",
): void {
  const nextPath = `${routeToPath(route, options)}${search}`;
  if (typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== nextPath) {
      incrementSpaNavDepth();
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
      hasAtRiskOpenPositions: hasAtRiskOpenPositions(currentState),
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
  if (!found) return "Copied Feed setup prompt.";
  if (found.cliCommand) return `Copied prompt & CLI for ${found.launcher.label}: ${found.cliCommand}`;
  if (found.notes) return `${found.launcher.label}: ${found.notes}`;
  return `Copied Feed setup prompt for ${found.launcher.label}.`;
}

export function openComposeDialog(quotePost: AppPost | null = null): void {
  if (!ensureViewerForDialog()) return;
  setStoreState({ ...CLOSED_DIALOGS, composeSession: { quotePost } });
}

export function closeComposeDialog(): void {
  setStoreState({ composeSession: null });
}

export function openReportDialog(target: GlobalReportTarget): void {
  if (!ensureViewerForDialog()) return;
  setStoreState({ ...CLOSED_DIALOGS, reportTarget: target });
}

export function closeReportDialog(): void {
  setStoreState({ reportTarget: null });
}

function ensureViewerForDialog(): boolean {
  if (currentState.viewer) return true;
  setStoreState(joinSheetOpenPatch());
  return false;
}

export function openBlockDialog(handle: string, currentlyActive: boolean): void {
  if (!ensureViewerForDialog()) return;
  setStoreState({ ...CLOSED_DIALOGS, blockTarget: { handle, currentlyActive } });
}

export function closeBlockDialog(): void {
  setStoreState({ blockTarget: null });
}

export function openMuteDialog(handle: string, currentlyActive: boolean): void {
  if (!ensureViewerForDialog()) return;
  setStoreState({ muteTarget: { handle, currentlyActive } });
}

export function closeMuteDialog(): void {
  setStoreState({ muteTarget: null });
}

export function openDeletePostDialog(postId: string): void {
  setStoreState({ deletePostTargetId: postId });
}

export function closeDeletePostDialog(): void {
  setStoreState({ deletePostTargetId: null });
}
