// spec/app/onboarding.md, "Story: Sign in through the Phone SMS door, AI Agent SKILL.md door, or Reviewer link"; spec/app/index.md, "Story: Connect and revoke the account's single AI agent"; spec/auth/email.md, "Story: Request and consume a single-use email magic link safely"
import type { AgentHostId, JoinEmailStep, JoinPhoneStep, JoinTab, UiMode } from "@repo/ui";
import { passThrough, requestJson } from "./api.ts";
import {
  buildHostActionNote,
  clearPersistedPendingAction,
  defaultJoinTab,
  getStoreSnapshot,
  joinSheetOpenPatch,
  navigateViaHook,
  notifyAuthChanged,
  persistExplainerDismissed,
  persistPendingAction,
  persistUiMode,
  pushBrowserRoute,
  pushToast,
  readPersistedPendingAction,
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
  loadClosedPositions,
  loadEconomy,
  loadExplore,
  loadFeed,
  loadLeaderboard,
  loadMarkets,
  loadNotifications,
  loadPositionsSilent,
  loadProfile,
  loadTrending,
  openThread,
  repostPost,
  resetAccountLoads,
  selectFeedTab,
  startDirectChat,
  submitPerpOrder,
  submitPredictionOrder,
  toggleFollow,
  toggleLike,
} from "./store-world.ts";
import {
  type PendingAction,
  decodeAdminReports,
  decodeAdminStatus,
  decodeAdminUsers,
  decodeAdminWorldFacts,
  decodeAuthMe,
  decodeDeviceLookup,
  decodeOAuthConsent,
  decodeSkillHosts,
  decodeViewer,
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
  FR: "+33",
  DE: "+49",
  NL: "+31",
  ES: "+34",
  IT: "+39",
  SE: "+46",
  DK: "+45",
  NO: "+47",
  FI: "+358",
  EU: "+",
};

let syncedMachineUiMode: "game" | "social" = "game";

function syncMachineUiMode(targetMode: "game" | "social"): void {
  if (syncedMachineUiMode === targetMode) return;
  syncedMachineUiMode = targetMode;
  sendNav({ type: "toggleUiMode" });
  sendApp({ type: "switchUiMode" });
}

const TRUNK_ZERO_COUNTRIES = new Set(["UK", "IE", "AU", "NZ", "FR", "DE", "NL", "ES", "SE", "DK", "NO", "FI"]);

export function formatPhoneToE164(country: string, rawPhone: string): string {
  const cleaned = rawPhone.trim().replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  const prefix = COUNTRY_PREFIX[country] ?? "+1";
  const digits = cleaned.replace(/\D/g, "");
  const national = TRUNK_ZERO_COUNTRIES.has(country) && digits.startsWith("0") ? digits.slice(1) : digits;
  return `${prefix}${national}`;
}

export async function loadSkillsHosts(): Promise<void> {
  const res = await requestJson("/api/skills/hosts", { parse: decodeSkillHosts });
  if (res.ok) {
    setStoreState({ skills: res.data });
  }
}

export async function hydrateAuth(): Promise<void> {
  const prevViewerId = getStoreSnapshot().viewer?.accountId ?? null;
  const prevUiMode = getStoreSnapshot().viewer?.uiMode ?? null;
  const res = await requestJson("/api/auth/me", { parse: decodeAuthMe });
  if (!res.ok) {
    setStoreState({ authLoaded: true });
    return;
  }
  const {
    authenticated,
    viewer,
    acceptedCountries,
    publicAppUrl,
    turnstileSiteKey,
    devSmsCodeEnabled,
    emailAuthEnabled,
    devEmailLinkEnabled,
  } = res.data;
  if (authenticated && viewer) {
    const switchedAccount = prevViewerId !== null && prevViewerId !== viewer.accountId;
    if (switchedAccount) {
      clearAccountStateKeepingRoute();
    }
    sendNav({ type: "signInNav", asAdmin: viewer.isAdmin });
    sendOnboarding({ type: "verifySmsCode", codeValid: true, isNewAccount: false });
    sendApp({ type: "verifyPhoneSms", codeValid: true, isNewAccount: false });
    syncMachineUiMode(viewer.uiMode);
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
      emailAuthEnabled,
      devEmailLinkEnabled,
      route: nextRoute,
      walletView: restrictedInSocial ? false : snap.walletView,
      localUiMode: viewer.uiMode,
      joinSheetOpen: false,
      joinError: null,
    });
    if (prevViewerId !== viewer.accountId) {
      notifyAuthChanged();
      if (switchedAccount) {
        await refreshViewerSurfaces();
      }
    } else if (prevUiMode !== viewer.uiMode) {
      await loadNotifications();
    }
    return;
  }
  if (prevViewerId !== null) {
    clearAccountStateKeepingRoute();
  }
  const snap = getStoreSnapshot();
  const currentRoute = snap.route;
  const protectedRoute = currentRoute === "Chats" || currentRoute === "Notifications" || currentRoute === "Settings" || currentRoute === "Admin";
  const fallbackRoute = protectedRoute ? "Home" : currentRoute;
  if (fallbackRoute !== currentRoute) {
    pushBrowserRoute(fallbackRoute);
  }
  setStoreState({
    authLoaded: true,
    viewer: null,
    acceptedCountries: acceptedCountries.length > 0 ? acceptedCountries : snap.acceptedCountries,
    publicAppUrl,
    turnstileSiteKey,
    devSmsCodeEnabled,
    emailAuthEnabled,
    devEmailLinkEnabled,
    joinTab: !emailAuthEnabled && snap.joinTab === "email" ? "phone" : snap.joinTab,
    route: fallbackRoute,
  });
  if (prevViewerId !== null) {
    notifyAuthChanged();
    await refreshViewerSurfaces();
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
      await submitPredictionOrder(action.marketId, action.action, action.side, action.amountPts, action.shareUnits);
      return;
    case "trade_perp":
      await submitPerpOrder(action.ticker, action.side, action.marginPts, action.leverage);
      return;
    case "persist_mode":
      await setPlayMode(action.mode);
      return;
    case "switch_tab":
      await selectFeedTab(action.tab);
      return;
    case "navigate":
      await navigateViaHook(action.path);
  }
}

export function openJoinSheet(tab?: JoinTab): void {
  const s = getStoreSnapshot();
  if (s.viewer) return;
  const resolvedTab = tab ?? defaultJoinTab(s);
  const effectiveTab: JoinTab = resolvedTab === "email" && !s.emailAuthEnabled ? "phone" : resolvedTab;
  sendOnboarding({ type: "openJoinSheetDirectly" });
  sendApp({ type: "openJoinSheet" });
  setStoreState(joinSheetOpenPatch(effectiveTab));
}

export function setJoinSheetOpen(open: boolean): void {
  if (open) {
    openJoinSheet();
    return;
  }
  sendOnboarding({ type: "closeJoinSheet" });
  sendApp({ type: "closeJoinSheetModal" });
  clearPersistedPendingAction();
  setStoreState({
    joinSheetOpen: false,
    joinError: null,
    joinEmailStep: "entry",
    joinPhoneStep: "entry",
    pendingEmail: "",
    pendingEmailMasked: "",
    devEmailMagicLinkUrl: null,
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
  } else if (tab === "email") {
    sendOnboarding({ type: "proceedToEmailFromAgent" });
    sendApp({ type: "switchAgentToEmail" });
  }
  setStoreState({ joinTab: tab, joinError: null });
}

export function setJoinEmailStep(step: JoinEmailStep): void {
  setStoreState({ joinEmailStep: step, joinError: null });
}

export function setJoinPhoneStep(step: JoinPhoneStep): void {
  setStoreState({ joinPhoneStep: step, joinError: null });
}

function safeCurrentRedirectPath(): string {
  if (typeof window === "undefined") return "/";
  const path = `${window.location.pathname}${window.location.search}`;
  if (!path.startsWith("/") || path.startsWith("/auth/email")) return "/";
  return path;
}

export async function requestEmailMagicLink(email: string, turnstileToken?: string): Promise<boolean> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    setStoreState({ joinError: "Enter a valid email address." });
    return false;
  }
  const s = getStoreSnapshot();
  persistPendingAction(s.pendingAction);
  setStoreState({
    joinLoading: true,
    joinError: null,
    pendingEmail: trimmed,
    devEmailMagicLinkUrl: null,
  });
  const res = await requestJson("/api/auth/email/start", {
    method: "POST",
    body: {
      email: trimmed,
      redirectTo: safeCurrentRedirectPath(),
      ...(turnstileToken ? { turnstileToken } : {}),
    },
    parse: passThrough,
  });
  if (!res.ok) {
    sendOnboarding({ type: "requestEmailMagicLink", emailValid: false });
    sendApp({ type: "requestEmailLink", emailValid: false });
    setStoreState({ joinLoading: false, joinEmailStep: "entry", joinError: res.message });
    return false;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const masked = optStr(rec.emailMasked) ?? trimmed;
  const devMagicLinkUrl = optStr(rec.devMagicLinkUrl);
  sendOnboarding({ type: "requestEmailMagicLink", emailValid: true });
  sendApp({ type: "requestEmailLink", emailValid: true });
  setStoreState({
    joinLoading: false,
    joinEmailStep: "sent",
    pendingEmail: trimmed,
    pendingEmailMasked: masked,
    devEmailMagicLinkUrl: devMagicLinkUrl,
    joinError: null,
  });
  return true;
}

export async function resendEmailMagicLink(): Promise<boolean> {
  const s = getStoreSnapshot();
  if (!s.pendingEmail) return false;
  if (s.turnstileSiteKey) {
    setStoreState({ joinEmailStep: "entry", joinError: "Complete security verification to resend the link." });
    return false;
  }
  return requestEmailMagicLink(s.pendingEmail);
}

export async function verifyEmailMagicLink(token: string | null): Promise<void> {
  const cleaned = (token ?? "").trim();
  if (!cleaned) {
    setStoreState({
      emailVerifyStatus: "error",
      emailVerifyError: "This sign-in link is missing a token or has expired.",
    });
    return;
  }
  setStoreState({
    emailVerifyStatus: "verifying",
    emailVerifyError: null,
    joinSheetOpen: false,
  });
  const res = await requestJson("/api/auth/email/verify", {
    method: "POST",
    body: { token: cleaned },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({
      emailVerifyStatus: "error",
      emailVerifyError: res.message,
    });
    return;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const status = str(rec.status, "signed_in");
  const redirectTo = optStr(rec.redirectTo);

  if (status === "email_linked") {
    const linked = decodeViewer(isRecord(res.data) ? res.data.account : null);
    const viewer = getStoreSnapshot().viewer;
    setStoreState({
      emailVerifyStatus: "linked",
      emailVerifyError: null,
      devEmailMagicLinkUrl: null,
      ...(linked && viewer && linked.accountId === viewer.accountId
        ? {
            viewer: {
              ...viewer,
              emailMasked: linked.emailMasked ?? viewer.emailMasked,
              emailVerifiedAt: linked.emailVerifiedAt ?? viewer.emailVerifiedAt,
            },
          }
        : {}),
    });
    await hydrateAuth();
    setStatusNotice("Email address linked.");
    await navigateViaHook(redirectTo && redirectTo.startsWith("/") ? redirectTo : "/settings?tab=account");
    return;
  }

  if (status === "needs_onboarding" || rec.needsOnboarding === true) {
    const onboardingToken = str(rec.onboardingToken ?? rec.pendingToken, "");
    const emailMasked = str(rec.emailMasked, getStoreSnapshot().pendingEmailMasked);
    sendOnboarding({ type: "verifyEmailMagicLink", tokenValid: true, isNewAccount: true });
    sendApp({ type: "verifyEmailLink", tokenValid: true, isNewAccount: true });
    setStoreState({
      emailVerifyStatus: "needs_onboarding",
      emailVerifyError: null,
      emailVerifyRedirectTo: redirectTo,
      pendingOnboardingToken: onboardingToken,
      pendingEmailMasked: emailMasked,
      joinEmailStep: "profile",
      devEmailMagicLinkUrl: null,
    });
    return;
  }

  sendOnboarding({ type: "verifyEmailMagicLink", tokenValid: true, isNewAccount: false });
  sendApp({ type: "verifyEmailLink", tokenValid: true, isNewAccount: false });
  const pending = getStoreSnapshot().pendingAction ?? readPersistedPendingAction();
  clearPersistedPendingAction();
  setStoreState({
    emailVerifyStatus: "signed_in",
    emailVerifyError: null,
    pendingAction: null,
    joinSheetOpen: false,
    joinEmailStep: "entry",
    devEmailMagicLinkUrl: null,
  });
  await hydrateAuth();
  await runPendingAction(pending);
  setStatusNotice("Signed in.");
  const target = redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("/auth/email") ? redirectTo : "/";
  if (pending?.kind !== "navigate") {
    await navigateViaHook(target);
  }
  await refreshViewerSurfaces();
}

export async function completeEmailOnboard(payload: {
  readonly username: string;
  readonly displayName?: string;
  readonly ageConfirmed: boolean;
  readonly acceptedTerms: boolean;
}): Promise<boolean> {
  const s = getStoreSnapshot();
  const onboardingToken = s.pendingOnboardingToken;
  setStoreState({ joinLoading: true, joinError: null, emailVerifyError: null });
  const res = await requestJson("/api/auth/email/onboard", {
    method: "POST",
    body: {
      onboardingToken,
      pendingToken: onboardingToken,
      username: payload.username,
      ...(payload.displayName?.trim() ? { displayName: payload.displayName.trim() } : {}),
      ageConfirmed: payload.ageConfirmed,
      accepted18Plus: payload.ageConfirmed,
      tosAccepted: payload.acceptedTerms,
      acceptedTerms: payload.acceptedTerms,
    },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ joinLoading: false, joinError: res.message, emailVerifyError: res.message });
    return false;
  }
  sendOnboarding({
    type: "completeNewEmailProfile",
    usernameValid: true,
    age18Plus: payload.ageConfirmed,
    acceptedTerms: payload.acceptedTerms,
  });
  sendApp({
    type: "completeEmailSignUp",
    usernameValid: true,
    age18Plus: payload.ageConfirmed,
    acceptedTerms: payload.acceptedTerms,
  });
  const pending = s.pendingAction ?? readPersistedPendingAction();
  const redirectTo = s.emailVerifyRedirectTo;
  clearPersistedPendingAction();
  setStoreState({
    joinLoading: false,
    pendingOnboardingToken: "",
    pendingAction: null,
    joinSheetOpen: false,
    joinEmailStep: "entry",
    emailVerifyStatus: "signed_in",
    emailVerifyError: null,
    emailVerifyRedirectTo: null,
    devEmailMagicLinkUrl: null,
  });
  setStatusNotice("Welcome to Feed. 100 pts credited.");
  await hydrateAuth();
  await runPendingAction(pending);
  const target = redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("/auth/email") ? redirectTo : "/";
  if (pending?.kind !== "navigate") {
    await navigateViaHook(target);
  }
  await refreshViewerSurfaces();
  return true;
}

export async function startEmailLink(email: string, turnstileToken?: string): Promise<{
  readonly ok: boolean;
  readonly emailMasked?: string;
  readonly devMagicLinkUrl?: string | null;
}> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    setErrorNotice("Enter a valid email address.");
    return { ok: false };
  }
  const res = await requestJson("/api/auth/email/link/start", {
    method: "POST",
    body: { email: trimmed, ...(turnstileToken ? { turnstileToken } : {}) },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return { ok: false };
  }
  const rec = isRecord(res.data) ? res.data : {};
  const emailMasked = optStr(rec.emailMasked) ?? trimmed;
  const devMagicLinkUrl = optStr(rec.devMagicLinkUrl);
  setStoreState({ devEmailMagicLinkUrl: devMagicLinkUrl });
  setStatusNotice(`Confirmation link sent to ${emailMasked}.`);
  return { ok: true, emailMasked, devMagicLinkUrl };
}

export async function requestSmsCode(country: string, phone: string, turnstileToken?: string): Promise<boolean> {
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
    return false;
  }
  sendOnboarding({ type: "requestSmsCode", phoneAllowed: true, notVoip: true });
  sendApp({ type: "requestPhoneSms", phoneAllowed: true, notVoip: true });
  setStoreState({ joinLoading: false, joinPhoneStep: "verify", joinError: null });
  return true;
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

export async function verifySmsCode(code: string): Promise<boolean> {
  const phoneE164 = getStoreSnapshot().pendingPhoneE164;
  if (!phoneE164) {
    setStoreState({ joinPhoneStep: "entry", joinError: "Enter your mobile number first." });
    return false;
  }
  setStoreState({ joinLoading: true, joinError: null });
  const res = await requestJson("/api/auth/phone/verify", {
    method: "POST",
    body: { phoneE164, code },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ joinLoading: false, joinPhoneStep: "verify", joinError: res.message });
    return false;
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
    return true;
  }
  const pending = getStoreSnapshot().pendingAction;
  setStoreState({ joinLoading: false, pendingAction: null, joinSheetOpen: false, joinPhoneStep: "entry" });
  await hydrateAuth();
  await runPendingAction(pending);
  await refreshViewerSurfaces();
  return true;
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
  if (s.route === "Markets") {
    tasks.push(loadMarkets());
    if (s.walletView && s.viewer) {
      tasks.push(loadEconomy(), loadClosedPositions());
    }
  }
  if (s.route === "Leaderboard") tasks.push(loadLeaderboard());
  if (s.viewer) {
    tasks.push(loadNotifications());
    tasks.push(loadChats(s.route === "Chats"));
    if (s.route !== "Markets") {
      tasks.push(loadPositionsSilent());
    }
  }
  if (s.route === "Profile") tasks.push(loadProfile(s.profileHandle));
  if (s.route === "OAuthConsent" && typeof window !== "undefined") tasks.push(loadOAuthConsent(window.location.search));
  await Promise.all(tasks);
}

export async function setPlayMode(nextMode: "game" | "social"): Promise<boolean> {
  const s = getStoreSnapshot();
  const prevMode = s.viewer ? s.viewer.uiMode : s.localUiMode;
  if (prevMode === nextMode) return true;
  const leavingGameRoute = nextMode === "social" && (s.route === "Markets" || s.route === "Leaderboard" || s.walletView);
  if (!s.viewer) {
    syncMachineUiMode(nextMode);
    persistUiMode(nextMode);
    if (leavingGameRoute) {
      pushBrowserRoute("Home");
    }
    setStoreState({
      localUiMode: nextMode,
      route: leavingGameRoute ? "Home" : s.route,
      walletView: leavingGameRoute ? false : s.walletView,
    });
    await refreshViewerSurfaces();
    return true;
  }
  const res = await requestJson("/api/auth/mode", {
    method: "POST",
    body: { mode: nextMode },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  syncMachineUiMode(nextMode);
  if (leavingGameRoute) {
    pushBrowserRoute("Home");
  }
  setStoreState({
    localUiMode: nextMode,
    viewer: { ...s.viewer, uiMode: nextMode },
    route: leavingGameRoute ? "Home" : s.route,
    walletView: leavingGameRoute ? false : s.walletView,
  });
  setStatusNotice(nextMode === "social" ? "Social mode enabled." : "Game mode enabled.");
  await refreshViewerSurfaces();
  return true;
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
  const formatted = formatPhoneToE164("US", newPhoneE164);
  const res = await requestJson("/api/auth/phone/change/start", {
    method: "POST",
    body: { newPhoneE164: formatted, ...(turnstileToken ? { turnstileToken } : {}) },
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
  const formatted = formatPhoneToE164("US", newPhoneE164);
  const res = await requestJson("/api/auth/phone/change/confirm", {
    method: "POST",
    body: { newPhoneE164: formatted, code },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const confirmed = decodeViewer(isRecord(res.data) ? res.data.account : null);
  const viewer = getStoreSnapshot().viewer;
  if (confirmed && viewer && confirmed.accountId === viewer.accountId) {
    setStoreState({
      viewer: {
        ...viewer,
        phoneLast2: confirmed.phoneLast2 ?? viewer.phoneLast2,
        phoneVerifiedAt: confirmed.phoneVerifiedAt ?? viewer.phoneVerifiedAt,
      },
    });
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
  pushBrowserRoute("Home");
  setStoreState({ route: "Home", walletView: false });
  clearAccountState();
  setStatusNotice(statusMessage);
  notifyAuthChanged();
  await loadFeed("latest");
}

function clearAccountStateKeepingRoute(): void {
  const { activePostId, profileHandle } = getStoreSnapshot();
  clearAccountState();
  setStoreState({ activePostId, profileHandle });
}

function clearAccountState(): void {
  clearPersistedPendingAction();
  sendNav({ type: "signOutNav" });
  sendOnboarding({ type: "signOutOnboarding" });
  sendApp({ type: "signOutApp" });
  resetAccountLoads();
  setStoreState({
    viewer: null,
    feedTab: "latest",
    feedPosts: [],
    feedNextCursor: null,
    feedLoadingMore: false,
    pendingNewPostCount: 0,
    chats: [],
    selectedChatId: null,
    chatMessages: [],
    alphaInvites: [],
    notifications: [],
    unreadNotifications: 0,
    positions: [],
    closedPositions: [],
    economy: null,
    ledger: [],
    pnlTimeRange: "ALL",
    pnlHistory: [],
    pnlHistoryLoading: false,
    perpPreview: null,
    leaderboardCurrentUser: null,
    blockedAccounts: [],
    mutedAccounts: [],
    profileHandle: null,
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    profileTrades: [],
    activeThread: null,
    activePostId: null,
    adminStatus: null,
    adminReports: [],
    adminUsers: [],
    adminFacts: [],
    oauthConsent: null,
    oauthError: null,
    deviceLookup: null,
    linkStatus: null,
    linkError: null,
    followListKind: null,
    followListHandle: null,
    followListItems: [],
    emailVerifyStatus: "idle",
    emailVerifyError: null,
    emailVerifyRedirectTo: null,
    devEmailMagicLinkUrl: null,
    pendingAction: null,
  });
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
    statusMessage: "Account deleted. Linked credentials held in 30-day cooldown.",
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

export async function lookupDeviceCode(userCode: string): Promise<void> {
  const cleaned = userCode.trim().toUpperCase();
  if (!cleaned) {
    setStoreState({ deviceLookup: null, deviceLookupLoading: false, linkError: "Enter a pairing code to look up." });
    return;
  }
  setStoreState({ deviceLookupLoading: true, linkError: null, linkStatus: null });
  const res = await requestJson(`/api/oauth/device/lookup?userCode=${encodeURIComponent(cleaned)}`, {
    parse: decodeDeviceLookup,
  });
  if (!res.ok || !res.data) {
    setStoreState({
      deviceLookupLoading: false,
      deviceLookup: null,
      linkError: res.ok ? "Pairing code not found or expired." : res.message,
    });
    return;
  }
  setStoreState({
    deviceLookupLoading: false,
    deviceLookup: res.data,
    linkError: null,
  });
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
  const clientName = optStr(rec.clientName) ?? getStoreSnapshot().deviceLookup?.clientName ?? null;
  if (!deny && clientName) {
    sendApp({ type: "connectSingleAgent", clientName });
  }
  setStoreState({
    linkLoading: false,
    deviceLookup: null,
    linkStatus: deny ? "Device authorization denied." : `Approved ${clientName ?? "agent"} (${userCode.trim().toUpperCase()}).`,
  });
  await hydrateAuth();
}

let adminStatusRequestSeq = 0;

export async function loadAdminStatus(): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  const reqSeq = ++adminStatusRequestSeq;
  setStoreState({ adminLoading: true });
  const res = await requestJson("/api/admin/status", { parse: decodeAdminStatus });
  if (reqSeq !== adminStatusRequestSeq) return;
  if (!res.ok) {
    setStoreState({ adminLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ adminLoading: false, adminStatus: res.data });
}

let adminReportsRequestSeq = 0;

export async function loadAdminReports(status: "all" | "open" | "reviewed" | "dismissed" = "open"): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  const reqSeq = ++adminReportsRequestSeq;
  setStoreState({ adminTabLoading: true });
  const res = await requestJson(`/api/admin/reports?status=${encodeURIComponent(status)}&limit=50`, {
    parse: decodeAdminReports,
  });
  if (reqSeq !== adminReportsRequestSeq) return;
  if (!res.ok) {
    setStoreState({ adminTabLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ adminTabLoading: false, adminReports: res.data });
}

export async function adminResolveReport(reportId: string, status: "reviewed" | "dismissed"): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, {
    method: "POST",
    body: { status },
    parse: passThrough,
  });
  const msg = res.ok ? `Marked report ${status}.` : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminReports("open");
}

let adminUsersRequestSeq = 0;

export async function loadAdminUsers(query = ""): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  const reqSeq = ++adminUsersRequestSeq;
  setStoreState({ adminTabLoading: true });
  const q = query.trim();
  const url = q ? `/api/admin/users?q=${encodeURIComponent(q)}&limit=50` : "/api/admin/users?limit=50";
  const res = await requestJson(url, { parse: decodeAdminUsers });
  if (reqSeq !== adminUsersRequestSeq) return;
  if (!res.ok) {
    setStoreState({ adminTabLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ adminTabLoading: false, adminUsers: res.data });
}

let adminFactsRequestSeq = 0;

export async function loadAdminWorldFacts(): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  const reqSeq = ++adminFactsRequestSeq;
  setStoreState({ adminTabLoading: true });
  const res = await requestJson("/api/admin/world-facts?limit=100", { parse: decodeAdminWorldFacts });
  if (reqSeq !== adminFactsRequestSeq) return;
  if (!res.ok) {
    setStoreState({ adminTabLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ adminTabLoading: false, adminFacts: res.data });
}

export async function adminCreateWorldFact(factText: string, category: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer?.isAdmin) return false;
  const trimmed = factText.trim();
  if (!trimmed) return false;
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson("/api/admin/world-facts", {
    method: "POST",
    body: { factText: trimmed, category: category.trim() || "markets" },
    parse: passThrough,
  });
  const msg = res.ok ? "World fact added." : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminWorldFacts();
  return res.ok;
}

export async function adminDeleteWorldFact(factId: string): Promise<void> {
  if (!getStoreSnapshot().viewer?.isAdmin) return;
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson(`/api/admin/world-facts/${encodeURIComponent(factId)}`, {
    method: "DELETE",
    parse: passThrough,
  });
  const msg = res.ok ? "World fact deleted." : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminWorldFacts();
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
  outcome?: "yes" | "no",
  reason = "",
): Promise<void> {
  setStoreState({ adminLoading: true, adminMessage: null });
  const res = await requestJson(`/api/admin/holds/${encodeURIComponent(marketId)}/${action}`, {
    method: "POST",
    body: {
      ...(outcome ? { outcome } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    },
    parse: passThrough,
  });
  const msg = res.ok
    ? outcome
      ? `Resolved hold ${marketId} as ${outcome.toUpperCase()}.`
      : `Approved hold ${marketId}.`
    : res.message;
  setStoreState({ adminLoading: false, adminMessage: msg });
  pushToast(msg, res.ok ? "ok" : "destructive");
  if (res.ok) await loadAdminStatus();
}
