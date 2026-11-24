// spec/app/onboarding.md, "Story: Sign in through the Phone SMS door, AI Agent SKILL.md door, or Reviewer link"; spec/app/index.md, "Story: Connect and revoke the account's single AI agent"
import type { AgentHostId, JoinPhoneStep, JoinTab, UiMode } from "@repo/ui";
import { passThrough, requestJson } from "./api.ts";
import {
  buildHostActionNote,
  getStoreSnapshot,
  notifyAuthChanged,
  persistExplainerDismissed,
  pushBrowserRoute,
  pushToast,
  sendApp,
  sendNav,
  sendOnboarding,
  setErrorNotice,
  setStatusNotice,
  setStoreState,
} from "./store-core.ts";
import {
  createPost,
  loadArticle,
  loadChats,
  loadExplore,
  loadFeed,
  loadMarkets,
  loadNotifications,
  loadPositionsSilent,
  loadProfile,
  loadTrending,
  openThread,
  repostPost,
  selectFeedTab,
  startDirectChat,
  submitPerpOrder,
  submitPredictionOrder,
  toggleFollow,
  toggleLike,
} from "./store-world.ts";
import {
  type PendingAction,
  decodeAdminStatus,
  decodeAuthMe,
  decodeOAuthConsent,
  decodeSkillHosts,
  isRecord,
  optStr,
  str,
  toSpecAgentHost,
} from "./types.ts";

const COUNTRY_PREFIX: Record<string, string> = {
  US: "+1",
  CA: "+1",
  UK: "+44",
  IE: "+353",
  AU: "+61",
  NZ: "+64",
  EU: "+",
};

export function formatPhoneToE164(country: string, rawPhone: string): string {
  const cleaned = rawPhone.trim().replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  const prefix = COUNTRY_PREFIX[country] ?? "+1";
  const digits = cleaned.replace(/\D/g, "");
  if (prefix === "+") return `+${digits}`;
  return `${prefix}${digits}`;
}

export async function loadSkillsHosts(): Promise<void> {
  const res = await requestJson("/api/skills/hosts", { parse: decodeSkillHosts });
  if (res.ok) {
    setStoreState({ skills: res.data });
  }
}

export async function hydrateAuth(): Promise<void> {
  const prevViewerId = getStoreSnapshot().viewer?.accountId ?? null;
  const res = await requestJson("/api/auth/me", { parse: decodeAuthMe });
  if (!res.ok) {
    setStoreState({ authLoaded: true });
    return;
  }
  const { authenticated, viewer, acceptedCountries, publicAppUrl, turnstileSiteKey, devSmsCodeEnabled } = res.data;
  if (authenticated && viewer) {
    sendNav({ type: "signInNav", asAdmin: viewer.isAdmin });
    sendOnboarding({ type: "verifySmsCode", codeValid: true, isNewAccount: false });
    sendApp({ type: "verifyPhoneSms", codeValid: true, isNewAccount: false });
    if (viewer.uiMode === "social") {
      sendNav({ type: "toggleUiMode" });
      sendApp({ type: "switchUiMode" });
    }
    if (viewer.agentGrant) {
      sendApp({ type: "connectSingleAgent", clientName: viewer.agentGrant.clientName });
    }
    const snap = getStoreSnapshot();
    const restrictedInSocial = viewer.uiMode === "social" && (snap.route === "Markets" || snap.route === "Leaderboard" || snap.walletView);
    const nextRoute = restrictedInSocial ? "Home" : snap.route;
    if (nextRoute !== snap.route || (restrictedInSocial && snap.walletView)) {
      pushBrowserRoute(nextRoute);
    }
    setStoreState({
      authLoaded: true,
      viewer,
      acceptedCountries: acceptedCountries.length > 0 ? acceptedCountries : snap.acceptedCountries,
      publicAppUrl,
      turnstileSiteKey,
      devSmsCodeEnabled,
      route: nextRoute,
      walletView: restrictedInSocial ? false : snap.walletView,
      localUiMode: viewer.uiMode,
      joinSheetOpen: false,
      joinError: null,
    });
    if (prevViewerId !== viewer.accountId) {
      notifyAuthChanged();
    }
    return;
  }
  const currentRoute = getStoreSnapshot().route;
  const protectedRoute = currentRoute === "Chats" || currentRoute === "Notifications" || currentRoute === "Settings" || currentRoute === "Admin";
  const fallbackRoute = protectedRoute ? "Home" : currentRoute;
  if (fallbackRoute !== currentRoute) {
    pushBrowserRoute(fallbackRoute);
  }
  setStoreState({
    authLoaded: true,
    viewer: null,
    acceptedCountries: acceptedCountries.length > 0 ? acceptedCountries : getStoreSnapshot().acceptedCountries,
    publicAppUrl,
    turnstileSiteKey,
    devSmsCodeEnabled,
    route: fallbackRoute,
  });
  if (prevViewerId !== null) {
    notifyAuthChanged();
  }
}

async function runPendingAction(action: PendingAction | null): Promise<void> {
  if (!action) return;
  switch (action.kind) {
    case "like":
      await toggleLike(action.postId);
      return;
    case "repost":
      await repostPost(action.postId);
      return;
    case "reply":
      await createPost(action.content, { replyToPostId: action.postId });
      return;
    case "post":
      await createPost(action.content, action.quotePostId ? { quotePostId: action.quotePostId } : undefined);
      return;
    case "follow":
      await toggleFollow(action.handle, action.currentlyFollowing);
      return;
    case "dm":
      await startDirectChat(action.handle);
      return;
    case "trade_prediction":
      await submitPredictionOrder(action.marketId, action.action, action.side, action.amountPts);
      return;
    case "trade_perp":
      await submitPerpOrder(action.ticker, action.side, action.marginPts, action.leverage);
      return;
    case "persist_mode":
      await setPlayMode(action.mode);
      return;
    case "switch_tab":
      await selectFeedTab(action.tab);
  }
}

export function openJoinSheet(tab: JoinTab = "phone"): void {
  if (getStoreSnapshot().viewer) return;
  sendOnboarding({ type: "openJoinSheetDirectly" });
  sendApp({ type: "openJoinSheet" });
  setStoreState({
    joinSheetOpen: true,
    joinTab: tab,
    joinPhoneStep: "entry",
    joinError: null,
  });
}

export function setJoinSheetOpen(open: boolean): void {
  if (open) {
    openJoinSheet();
    return;
  }
  sendOnboarding({ type: "closeJoinSheet" });
  sendApp({ type: "closeJoinSheetModal" });
  setStoreState({
    joinSheetOpen: false,
    joinError: null,
    joinPhoneStep: "entry",
    pendingAction: null,
  });
}

export function setJoinTab(tab: JoinTab): void {
  if (tab === "reviewer") {
    sendOnboarding({ type: "openReviewerDoor" });
    sendApp({ type: "openReviewerSignIn" });
  } else if (tab === "phone") {
    sendOnboarding({ type: "proceedToPhoneFromAgent" });
    sendApp({ type: "switchAgentToPhone" });
  }
  setStoreState({ joinTab: tab, joinError: null });
}

export function setJoinPhoneStep(step: JoinPhoneStep): void {
  setStoreState({ joinPhoneStep: step });
}

export async function requestSmsCode(country: string, phone: string, turnstileToken?: string): Promise<void> {
  const phoneE164 = formatPhoneToE164(country, phone);
  setStoreState({ joinLoading: true, joinError: null, pendingPhoneE164: phoneE164 });
  const res = await requestJson("/api/auth/phone/start", {
    method: "POST",
    body: { phoneE164, ...(turnstileToken ? { turnstileToken } : {}) },
    parse: passThrough,
  });
  if (!res.ok) {
    sendOnboarding({ type: "requestSmsCode", phoneAllowed: false, notVoip: false });
    sendApp({ type: "requestPhoneSms", phoneAllowed: false, notVoip: false });
    setStoreState({ joinLoading: false, joinPhoneStep: "entry", joinError: res.message });
    return;
  }
  sendOnboarding({ type: "requestSmsCode", phoneAllowed: true, notVoip: true });
  sendApp({ type: "requestPhoneSms", phoneAllowed: true, notVoip: true });
  setStoreState({ joinLoading: false, joinPhoneStep: "verify", joinError: null });
}

export async function resendSmsCode(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.pendingPhoneE164) return;
  if (s.turnstileSiteKey) {
    setStoreState({ joinPhoneStep: "entry", joinError: "Complete security verification to resend the code." });
    return;
  }
  await requestSmsCode("EU", s.pendingPhoneE164);
}

export async function verifySmsCode(code: string): Promise<void> {
  const phoneE164 = getStoreSnapshot().pendingPhoneE164;
  if (!phoneE164) {
    setStoreState({ joinPhoneStep: "entry", joinError: "Enter your mobile number first." });
    return;
  }
  setStoreState({ joinLoading: true, joinError: null });
  const res = await requestJson("/api/auth/phone/verify", {
    method: "POST",
    body: { phoneE164, code },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ joinLoading: false, joinPhoneStep: "verify", joinError: res.message });
    return;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const status = str(rec.status, "signed_in");
  if (status === "needs_onboarding" || rec.needsOnboarding === true) {
    const pendingToken = str(rec.pendingToken, "");
    sendOnboarding({ type: "verifySmsCode", codeValid: true, isNewAccount: true });
    sendApp({ type: "verifyPhoneSms", codeValid: true, isNewAccount: true });
    setStoreState({
      joinLoading: false,
      joinPhoneStep: "profile",
      pendingOnboardingToken: pendingToken,
      joinError: null,
    });
    return;
  }
  const pending = getStoreSnapshot().pendingAction;
  setStoreState({ joinLoading: false, pendingAction: null, joinSheetOpen: false, joinPhoneStep: "entry" });
  await hydrateAuth();
  notifyAuthChanged();
  await runPendingAction(pending);
  await refreshViewerSurfaces();
}

export async function completePhoneOnboard(payload: {
  readonly username: string;
  readonly ageConfirmed: boolean;
  readonly acceptedTerms: boolean;
}): Promise<void> {
  const pendingToken = getStoreSnapshot().pendingOnboardingToken;
  setStoreState({ joinLoading: true, joinError: null });
  const res = await requestJson("/api/auth/phone/onboard", {
    method: "POST",
    body: {
      pendingToken,
      username: payload.username,
      accepted18Plus: payload.ageConfirmed,
      acceptedTerms: payload.acceptedTerms,
    },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ joinLoading: false, joinPhoneStep: "profile", joinError: res.message });
    return;
  }
  sendOnboarding({
    type: "completeNewPhoneProfile",
    usernameValid: true,
    age18Plus: payload.ageConfirmed,
    acceptedTerms: payload.acceptedTerms,
  });
  sendApp({
    type: "completePhoneSignUp",
    usernameValid: true,
    age18Plus: payload.ageConfirmed,
    acceptedTerms: payload.acceptedTerms,
  });
  const pending = getStoreSnapshot().pendingAction;
  setStoreState({
    joinLoading: false,
    pendingOnboardingToken: "",
    pendingAction: null,
    joinSheetOpen: false,
    joinPhoneStep: "entry",
  });
  setStatusNotice("Welcome to Feed. 100 pts credited.");
  await hydrateAuth();
  notifyAuthChanged();
  await runPendingAction(pending);
  await refreshViewerSurfaces();
}

export async function submitReviewerLogin(payload: { readonly identifier: string; readonly password: string }): Promise<void> {
  setStoreState({ joinLoading: true, joinError: null });
  const res = await requestJson("/api/auth/reviewer/login", {
    method: "POST",
    body: { username: payload.identifier, password: payload.password },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ joinLoading: false, joinError: res.message });
    return;
  }
  sendOnboarding({ type: "submitReviewerSignIn", isReviewerAccount: true, passwordValid: true });
  sendApp({ type: "completeReviewerSignIn", isReviewerAccount: true, passwordValid: true });
  const pending = getStoreSnapshot().pendingAction;
  setStoreState({ joinLoading: false, pendingAction: null, joinSheetOpen: false });
  await hydrateAuth();
  notifyAuthChanged();
  await runPendingAction(pending);
  await refreshViewerSurfaces();
}

export async function refreshViewerSurfaces(): Promise<void> {
  const s = getStoreSnapshot();
  const tasks: Promise<void>[] = [loadFeed(), loadTrending()];
  if (s.route === "Explore") {
    if (s.activeArticleId) {
      tasks.push(loadArticle(s.activeArticleId));
    } else {
      tasks.push(loadExplore(s.exploreQuery));
    }
  }
  if (s.route === "PostDetail" && s.activePostId) {
    tasks.push(openThread(s.activePostId, s.threadSort));
  }
  if (s.route === "Markets" || s.route === "Leaderboard") tasks.push(loadMarkets());
  if (s.viewer) {
    tasks.push(loadNotifications());
    tasks.push(loadChats(s.route === "Chats"));
    if (s.route !== "Markets" && s.route !== "Leaderboard") {
      tasks.push(loadPositionsSilent());
    }
  }
  if (s.route === "Profile") tasks.push(loadProfile(s.profileHandle));
  if (s.route === "OAuthConsent" && typeof window !== "undefined") tasks.push(loadOAuthConsent(window.location.search));
  await Promise.all(tasks);
}

export async function setPlayMode(nextMode: "game" | "social"): Promise<void> {
  const s = getStoreSnapshot();
  const prevMode = s.viewer ? s.viewer.uiMode : s.localUiMode;
  if (prevMode === nextMode) return;
  sendNav({ type: "toggleUiMode" });
  sendApp({ type: "switchUiMode" });
  const leavingGameRoute = nextMode === "social" && (s.route === "Markets" || s.route === "Leaderboard" || s.walletView);
  if (leavingGameRoute) {
    pushBrowserRoute("Home");
  }
  if (!s.viewer) {
    setStoreState({
      localUiMode: nextMode,
      route: leavingGameRoute ? "Home" : s.route,
      walletView: leavingGameRoute ? false : s.walletView,
    });
    await refreshViewerSurfaces();
    return;
  }
  const res = await requestJson("/api/auth/mode", {
    method: "POST",
    body: { mode: nextMode },
    parse: passThrough,
  });
  if (!res.ok) {
    sendNav({ type: "toggleUiMode" });
    sendApp({ type: "switchUiMode" });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({
    localUiMode: nextMode,
    viewer: { ...s.viewer, uiMode: nextMode },
    route: leavingGameRoute ? "Home" : s.route,
    walletView: leavingGameRoute ? false : s.walletView,
  });
  setStatusNotice(nextMode === "social" ? "Social mode enabled." : "Game mode enabled.");
  await refreshViewerSurfaces();
}

export function toggleUiModeFromControl(next: UiMode): void {
  void setPlayMode(next === "SocialMode" ? "social" : "game");
}

export function dismissExplainer(): void {
  sendOnboarding({ type: "dismissExplainerCard" });
  sendApp({ type: "dismissFirstVisitExplainer" });
  persistExplainerDismissed();
  setStoreState({ explainerDismissed: true });
}

export function dismissBottomBanner(): void {
  sendNav({ type: "dismissBanner" });
  sendApp({ type: "dismissVisitorBanner" });
  setStoreState({ bannerDismissed: true });
}

export async function copySkillPrompt(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
  const note = "Copied Feed agent prompt to clipboard.";
  setStoreState({ hostActionNote: note });
  pushToast(note, "info");
}

export function launchAgentHost(hostId: AgentHostId): void {
  const s = getStoreSnapshot();
  const host = s.skills.hosts.find((h) => h.launcher.id === hostId);
  const specHost = toSpecAgentHost(hostId);
  sendOnboarding({ type: "launchAgentDoor", host: specHost });
  sendApp({ type: "launchAgentSkillDoor", host: specHost });
  const textToCopy = host?.cliCommand ?? host?.prompt ?? s.skills.prompt;
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(textToCopy).catch(() => undefined);
  }
  if (host && host.resolvedLaunchKind !== "CopyPromptFallback" && host.launcher.href && typeof window !== "undefined") {
    if (host.launcher.href.startsWith("https://")) {
      window.open(host.launcher.href, "_blank", "noopener,noreferrer");
    } else {
      window.location.assign(host.launcher.href);
    }
  }
  const note = buildHostActionNote(hostId);
  setStoreState({ hostActionNote: note });
  pushToast(note, "info");
}

export async function revokeAgentGrant(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const res = await requestJson("/api/auth/agent-grant/revoke", {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  sendApp({ type: "revokeConnectedAgent" });
  setStoreState({
    viewer: { ...s.viewer, agentGrant: null },
  });
  setStatusNotice("Connected agent grant revoked.");
}

export async function fetchLoopbackCode(phoneE164: string): Promise<string | null> {
  const res = await requestJson(`/api/auth/dev/loopback-code?phone=${encodeURIComponent(phoneE164)}`, {
    parse: passThrough,
  });
  if (!res.ok || !isRecord(res.data)) return null;
  return optStr(res.data.code);
}

export async function startPhoneChange(newPhoneE164: string, turnstileToken?: string): Promise<boolean> {
  const res = await requestJson("/api/auth/phone/change/start", {
    method: "POST",
    body: { newPhoneE164, ...(turnstileToken ? { turnstileToken } : {}) },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice("Verification code sent to new number.");
  return true;
}

export async function confirmPhoneChange(newPhoneE164: string, code: string): Promise<boolean> {
  const res = await requestJson("/api/auth/phone/change/confirm", {
    method: "POST",
    body: { newPhoneE164, code },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice("Phone number updated.");
  await hydrateAuth();
  return true;
}

async function performSignOut({
  endpoint,
  statusMessage,
  ignoreFailure = false,
}: {
  readonly endpoint: string;
  readonly statusMessage: string;
  readonly ignoreFailure?: boolean;
}): Promise<void> {
  const res = await requestJson(endpoint, { method: "POST", body: {}, parse: passThrough });
  if (!ignoreFailure && !res.ok) {
    setErrorNotice(res.message);
    return;
  }
  sendNav({ type: "signOutNav" });
  sendOnboarding({ type: "signOutOnboarding" });
  sendApp({ type: "signOutApp" });
  pushBrowserRoute("Home");
  setStoreState({
    viewer: null,
    route: "Home",
    walletView: false,
    feedTab: "latest",
    chats: [],
    selectedChatId: null,
    chatMessages: [],
    alphaInvites: [],
    notifications: [],
    unreadNotifications: 0,
    positions: [],
    blockedAccounts: [],
    mutedAccounts: [],
  });
  setStatusNotice(statusMessage);
  notifyAuthChanged();
  await loadFeed("latest");
}

export async function logout(): Promise<void> {
  await performSignOut({
    endpoint: "/api/auth/logout",
    statusMessage: "Signed out.",
    ignoreFailure: true,
  });
}

export async function signOutEverywhere(): Promise<void> {
  await performSignOut({
    endpoint: "/api/auth/signout-everywhere",
    statusMessage: "Signed out across all sessions.",
  });
}

export async function deleteAccount(): Promise<void> {
  await performSignOut({
    endpoint: "/api/auth/account/delete",
    statusMessage: "Account deleted. Phone number held in 30-day cooldown.",
  });
}

export async function loadOAuthConsent(search: string): Promise<void> {
  setStoreState({ oauthLoading: true, oauthError: null });
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  const res = await requestJson(`/api/oauth/consent${query}`, { parse: decodeOAuthConsent });
  if (!res.ok) {
    setStoreState({ oauthLoading: false, oauthConsent: null, oauthError: res.message });
    return;
  }
  setStoreState({ oauthLoading: false, oauthConsent: res.data, oauthError: res.data?.error ?? null });
}

export async function submitOAuthDecision(approved: boolean, scopes: ReadonlyArray<string>): Promise<void> {
  const consent = getStoreSnapshot().oauthConsent;
  if (!consent) return;
  setStoreState({ oauthLoading: true, oauthError: null });
  const res = await requestJson("/api/oauth/authorize", {
    method: "POST",
    body: {
      clientId: consent.clientId,
      redirectUri: consent.redirectUri,
      scope: scopes.join(" "),
      scopes,
      state: consent.state,
      resource: consent.resource,
      codeChallenge: consent.codeChallenge,
      codeChallengeMethod: consent.codeChallengeMethod,
      responseType: consent.responseType,
      approved,
    },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ oauthLoading: false, oauthError: res.message });
    return;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const redirectTo = optStr(rec.redirectTo ?? rec.redirect_uri ?? rec.url);
  if (approved) {
    sendApp({ type: "connectSingleAgent", clientName: consent.clientName });
  }
  setStoreState({ oauthLoading: false });
  if (redirectTo && typeof window !== "undefined") {
    window.location.assign(redirectTo);
  }
}

export async function approveDeviceCode(userCode: string, scopes: ReadonlyArray<string>, deny = false): Promise<void> {
  setStoreState({ linkLoading: true, linkError: null, linkStatus: null });
  const res = await requestJson("/api/oauth/device/approve", {
    method: "POST",
    body: { userCode: userCode.trim().toUpperCase(), scopes, ...(deny ? { deny: true } : {}) },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ linkLoading: false, linkError: res.message });
    return;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const clientName = optStr(rec.clientName);
  if (!deny && clientName) {
    sendApp({ type: "connectSingleAgent", clientName });
  }
  setStoreState({
    linkLoading: false,
    linkStatus: deny ? "Device authorization denied." : `Approved ${clientName ?? "agent"} (${userCode.trim().toUpperCase()}).`,
  });
  await hydrateAuth();
}

export async function loadAdminStatus(): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  setStoreState({ adminLoading: true });
  const res = await requestJson("/api/admin/status", { parse: decodeAdminStatus });
  if (!res.ok) {
    setStoreState({ adminLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ adminLoading: false, adminStatus: res.data });
}

export async function adminFastForward(minutes: number): Promise<void> {
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson("/api/admin/clock/fast-forward", {
    method: "POST",
    body: { minutes },
    parse: passThrough,
  });
  const msg = res.ok ? `Clock fast-forwarded ${minutes}m.` : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminStatus();
}

export async function adminRunCron(job: string): Promise<void> {
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson(`/api/admin/cron/${encodeURIComponent(job)}`, {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  const msg = res.ok ? `Executed ${job}.` : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminStatus();
}

export async function adminResolveHold(
  marketId: string,
  action: "approve" | "override",
  outcome: "yes" | "no",
  reason: string,
): Promise<void> {
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson(`/api/admin/holds/${encodeURIComponent(marketId)}/${action}`, {
    method: "POST",
    body: { outcome, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    parse: passThrough,
  });
  const msg = res.ok ? `Resolved hold ${marketId} as ${outcome.toUpperCase()}.` : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminStatus();
}
