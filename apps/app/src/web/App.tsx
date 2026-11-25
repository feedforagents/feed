// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useState } from "react";
import {
  AppShell,
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FeedFullLogo,
  FeedIcon,
  JoinSheet,
  ModeToggle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
  ToastBanner,
  ToastViewport,
  type UiMode,
  formatPts,
} from "@repo/ui";
import {
  type NavState,
  initial as navInitial,
  showBottomBanner,
  visibleSurfaces,
} from "../../gen/app__navigation.ts";
import { useMachine as useNavMachine } from "../../gen/app__navigation.react.ts";
import { GlobalDialogs } from "./GlobalDialogs.tsx";
import {
  HelpIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PenIcon,
  SettingsIcon,
  ShieldIcon,
  SunIcon,
  TrophyIcon,
  UserIcon,
  WalletIcon,
  XIcon,
} from "./icons.tsx";
import { RightRail } from "./RightRail.tsx";
import { toAppNavRoute } from "./routes.ts";
import { ArticleDetailScreen } from "./screens/ArticleDetailScreen.tsx";
import { AdminScreen, LinkScreen, OAuthConsentScreen } from "./screens/AuthScreens.tsx";
import { ChatsScreen } from "./screens/ChatsScreen.tsx";
import { ExploreScreen } from "./screens/ExploreScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { HowToPlayScreen } from "./screens/HowToPlayScreen.tsx";
import { LeaderboardScreen, WalletScreen } from "./screens/GameScreens.tsx";
import { MarketsScreen } from "./screens/MarketsScreen.tsx";
import { NotificationsScreen } from "./screens/NotificationsScreen.tsx";
import { PostDetailScreen } from "./screens/PostDetailScreen.tsx";
import { ProfileScreen } from "./screens/ProfileScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { currentUiMode, hasAtRiskOpenPositions, toSpecTab } from "./store-core.ts";
import { navRuntime, storeActions, useAppStore } from "./store.ts";
import { visibleUnreadNotificationCount } from "./types.ts";
import type { ThemePreference } from "./types.ts";

function ThemeIcon({ theme, className }: { readonly theme: ThemePreference; readonly className?: string }) {
  if (theme === "light") return <SunIcon className={className} />;
  if (theme === "system") return <MonitorIcon className={className} />;
  return <MoonIcon className={className} />;
}

function themeLabel(theme: ThemePreference): string {
  if (theme === "light") return "Light";
  if (theme === "system") return "System";
  return "Dark";
}

function RailComposeAndGameLinks({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const isGame = mode === "GameMode";
  const onWallet = s.route === "Markets" && s.walletView;

  return (
    <div className="flex flex-col items-center gap-2 lg:items-stretch">
      {isGame ? (
        <div className="flex flex-col items-center gap-1 lg:items-stretch">
          <button
            type="button"
            aria-current={onWallet ? "page" : undefined}
            onClick={() => { void storeActions.navigate("/wallet"); }}
            className={`group flex items-center justify-center rounded-full px-3 py-2.5 text-lg transition-colors duration-fast hover:bg-accent lg:w-fit lg:justify-start lg:px-3.5 ${onWallet ? "font-bold text-foreground" : "font-normal text-foreground/85 hover:text-foreground"}`}
          >
            <span className="flex items-center gap-4">
              <WalletIcon className="size-6 shrink-0" />
              <span className="sr-only lg:not-sr-only">Wallet</span>
            </span>
          </button>
        </div>
      ) : null}

      <Button
        shape="pill"
        onClick={() => storeActions.openComposeDialog(null)}
        aria-label="Post"
        className="mt-1 h-11 w-11 p-0 font-bold lg:w-full lg:px-4"
      >
        <PenIcon className="size-5 lg:hidden" />
        <span className="hidden lg:inline">Post</span>
      </Button>
    </div>
  );
}

function RailModeControl({
  mode,
  showAtRiskNotice,
}: {
  readonly mode: UiMode;
  readonly showAtRiskNotice: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ModeToggle
        compact
        mode={mode}
        hasAtRiskOpenPositions={showAtRiskNotice}
        onModeChange={storeActions.toggleUiModeFromControl}
      />
      {showAtRiskNotice ? (
        <button
          type="button"
          onClick={() => storeActions.toggleUiModeFromControl("GameMode")}
          className="flex items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-1.5 text-left text-xs font-medium text-warn transition-colors hover:bg-warn/15"
        >
          <span>Open positions active</span>
          <span className="font-semibold underline">Game</span>
        </button>
      ) : null}
    </div>
  );
}

function RailUserMenu({
  mode,
  balancePts,
}: {
  readonly mode: UiMode;
  readonly balancePts?: string;
}) {
  const s = useAppStore();
  if (!s.viewer) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex w-full items-center justify-center gap-3 rounded-full p-2 text-left transition-colors duration-fast hover:bg-accent lg:justify-between lg:px-3"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar
              name={s.viewer.displayName}
              src={s.viewer.avatarUrl ?? undefined}
              seed={s.viewer.handle}
              size="sm"
            />
            <span className="hidden min-w-0 flex-col lg:flex">
              <span className="truncate text-sm font-bold text-foreground">{s.viewer.displayName}</span>
              <span className="truncate text-xs text-muted-foreground">
                @{s.viewer.handle}
                {mode === "GameMode" && balancePts ? ` · ${balancePts}` : ""}
              </span>
            </span>
          </span>
          <MoreHorizontalIcon className="hidden size-4 shrink-0 text-muted-foreground lg:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuItem onSelect={() => { void storeActions.navigate(`/u/${encodeURIComponent(s.viewer?.handle ?? "")}`); }}>
          <UserIcon className="size-4" />
          Profile (@{s.viewer.handle})
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void storeActions.navigate("/settings"); }}>
          <SettingsIcon className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void storeActions.navigate("/how-to-play"); }}>
          <HelpIcon className="size-4" />
          How to Play
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => storeActions.cycleTheme()}>
          <ThemeIcon theme={s.theme} className="size-4" />
          Theme: {themeLabel(s.theme)}
        </DropdownMenuItem>
        {s.viewer.isAdmin ? (
          <DropdownMenuItem onSelect={() => { void storeActions.navigate("/admin"); }}>
            <ShieldIcon className="size-4" />
            Admin console
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => { void storeActions.logout(); }}>
          <LogOutIcon className="size-4" />
          Sign out @{s.viewer.handle}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileDrawer({
  mode,
  balancePts,
}: {
  readonly mode: UiMode;
  readonly balancePts?: string;
}) {
  const s = useAppStore();
  const [open, setOpen] = useState(false);

  const go = (path: string) => {
    setOpen(false);
    void storeActions.navigate(path);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className="inline-flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring"
        >
          {s.viewer ? (
            <Avatar
              name={s.viewer.displayName}
              src={s.viewer.avatarUrl ?? undefined}
              seed={s.viewer.handle}
              size="sm"
            />
          ) : (
            <FeedIcon className="size-7 text-feed-brand" />
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="gap-5 p-5">
        <div className="flex flex-col gap-2">
          <SheetTitle className="flex items-center gap-2.5">
            {s.viewer ? (
              <Avatar
                name={s.viewer.displayName}
                src={s.viewer.avatarUrl ?? undefined}
                seed={s.viewer.handle}
                size="md"
              />
            ) : (
              <FeedFullLogo className="h-6 w-auto text-foreground" />
            )}
            {s.viewer ? (
              <span className="min-w-0">
                <span className="block truncate text-base font-bold">{s.viewer.displayName}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">@{s.viewer.handle}</span>
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription className="sr-only">Account and navigation drawer</SheetDescription>
          {s.viewer && mode === "GameMode" && balancePts ? (
            <p className="font-mono text-sm font-semibold text-foreground tabular-nums">{balancePts}</p>
          ) : null}
        </div>

        <nav aria-label="Account navigation" className="flex flex-col gap-1">
          {s.viewer ? (
            <button
              type="button"
              onClick={() => go(`/u/${encodeURIComponent(s.viewer?.handle ?? "")}`)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
            >
              <UserIcon className="size-4" />
              Profile
            </button>
          ) : null}
          {mode === "GameMode" ? (
            <>
              <button
                type="button"
                onClick={() => go("/leaderboard")}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
              >
                <TrophyIcon className="size-4" />
                Leaderboard
              </button>
              <button
                type="button"
                onClick={() => go("/wallet")}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
              >
                <WalletIcon className="size-4" />
                Wallet
              </button>
            </>
          ) : null}
          {s.viewer ? (
            <button
              type="button"
              onClick={() => go("/settings")}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
            >
              <SettingsIcon className="size-4" />
              Settings
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => go("/how-to-play")}
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
          >
            <HelpIcon className="size-4" />
            How to Play
          </button>
          {s.viewer?.isAdmin ? (
            <button
              type="button"
              onClick={() => go("/admin")}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:bg-accent"
            >
              <ShieldIcon className="size-4" />
              Admin console
            </button>
          ) : null}
        </nav>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="text-xs font-semibold text-muted-foreground">Appearance</span>
          <div className="grid grid-cols-3 gap-1.5">
            {(["dark", "light", "system"] as const).map((pref) => (
              <Button
                key={pref}
                size="sm"
                shape="pill"
                variant={s.theme === pref ? "primary" : "outline"}
                onClick={() => storeActions.setTheme(pref)}
              >
                {themeLabel(pref)}
              </Button>
            ))}
          </div>
        </div>

        <div className="mt-auto border-t border-border pt-4">
          {s.viewer ? (
            <Button
              variant="outline"
              shape="pill"
              className="w-full"
              onClick={() => {
                setOpen(false);
                void storeActions.logout();
              }}
            >
              <LogOutIcon className="size-4" />
              Sign out
            </Button>
          ) : (
            <Button
              shape="pill"
              className="w-full"
              onClick={() => {
                setOpen(false);
                storeActions.openJoinSheet("phone");
              }}
            >
              Sign in
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MobileHeaderActions({
  mode,
  signedIn,
}: {
  readonly mode: UiMode;
  readonly signedIn: boolean;
}) {
  return (
    <div className="flex items-center gap-2 md:hidden">
      <ModeToggle compact mode={mode} onModeChange={storeActions.toggleUiModeFromControl} />
      {!signedIn ? (
        <Button size="sm" shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
          Sign in
        </Button>
      ) : null}
    </div>
  );
}

function VisitorBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-feed-brand/30 bg-feed-brand px-4 py-3 text-feed-brand-foreground shadow-lg">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-bold">Don&apos;t miss what&apos;s happening</span>
        <span className="text-xs text-feed-brand-foreground/85">Join Feed to post, follow, and trade live.</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          shape="pill"
          variant="secondary"
          onClick={() => storeActions.openJoinSheet("phone")}
        >
          Sign in
        </Button>
        <Button
          size="sm"
          shape="pill"
          variant="outline"
          className="border-feed-brand-foreground/40 bg-transparent text-feed-brand-foreground hover:bg-feed-brand-foreground/10"
          onClick={() => storeActions.openJoinSheet("agent")}
        >
          Connect AI
        </Button>
        <button
          type="button"
          aria-label="Dismiss sign-in banner"
          onClick={storeActions.dismissBottomBanner}
          className="rounded-full p-1 text-feed-brand-foreground/80 transition-colors hover:bg-feed-brand-foreground/15 hover:text-feed-brand-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function ActiveRouteScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();

  switch (s.route) {
    case "Home":
      return <HomeScreen mode={mode} />;
    case "PostDetail":
      return <PostDetailScreen mode={mode} />;
    case "Explore":
      return s.activeArticleId ? (
        <ArticleDetailScreen mode={mode} />
      ) : (
        <ExploreScreen key={`${s.exploreQuery}:${s.activeTrendingTag ?? ""}`} mode={mode} />
      );
    case "Markets":
      if (mode === "SocialMode") return <HomeScreen mode={mode} />;
      return s.walletView ? <WalletScreen /> : <MarketsScreen />;
    case "Leaderboard":
      return mode === "SocialMode" ? <HomeScreen mode={mode} /> : <LeaderboardScreen />;
    case "Chats":
      return <ChatsScreen />;
    case "Notifications":
      return <NotificationsScreen mode={mode} />;
    case "Profile":
      return <ProfileScreen mode={mode} />;
    case "Settings":
      return <SettingsScreen mode={mode} />;
    case "HowToPlay":
      return <HowToPlayScreen />;
    case "Link":
      return <LinkScreen />;
    case "OAuthConsent":
      return <OAuthConsentScreen />;
    case "Admin":
      return <AdminScreen />;
  }
}

export function App() {
  const s = useAppStore();
  useNavMachine(navRuntime);

  const mode = currentUiMode(s);
  const atRisk = hasAtRiskOpenPositions(s);
  const effectiveNavState: NavState = {
    ...navInitial,
    route: s.route,
    feedTab: toSpecTab(s.feedTab),
    uiMode: mode,
    signedIn: s.viewer !== null,
    isAdmin: s.viewer?.isAdmin ?? false,
    scrolledDeep: s.scrolledDeep,
    itemsViewed: s.itemsViewed,
    bannerDismissed: s.bannerDismissed,
    hasAtRiskOpenPositions: atRisk,
  };
  const surfaces = visibleSurfaces(effectiveNavState);
  const bannerVisible = showBottomBanner(effectiveNavState);
  const unreadChats = s.chats.reduce((acc, c) => acc + c.unreadCount, 0) + s.alphaInvites.length;
  const balancePts = s.viewer && surfaces.showBalances ? formatPts(s.viewer.balanceCents / 100) : undefined;
  const isWideRoute = s.route === "Markets" || s.route === "Chats" || s.route === "Leaderboard" || s.route === "Admin";

  return (
    <>
      <AppShell
        route={toAppNavRoute(s.route)}
        activeRoute={s.activeArticleId ? null : undefined}
        headerTitle={s.activeArticleId ? "Article" : undefined}
        mode={mode}
        layout={isWideRoute ? "wide" : "social"}
        hideDesktopHeader
        signedIn={s.viewer !== null}
        unreadNotifications={visibleUnreadNotificationCount(s.notifications, mode)}
        unreadChats={unreadChats}
        balancePts={balancePts}
        onNavigate={storeActions.navigateRoute}
        onSignInClick={() => storeActions.openJoinSheet("phone")}
        brand={
          <button
            type="button"
            aria-label="Feed Home"
            onClick={() => { void storeActions.navigate("/"); }}
            className="inline-flex items-center rounded-full p-1 transition-opacity hover:opacity-85"
          >
            <FeedIcon className="size-8 text-feed-brand lg:hidden" />
            <FeedFullLogo className="hidden h-7 w-auto text-foreground lg:block" />
          </button>
        }
        composeAction={<RailComposeAndGameLinks mode={mode} />}
        modeControl={<RailModeControl mode={mode} showAtRiskNotice={surfaces.showAtRiskPositionsNotice} />}
        accountMenu={<RailUserMenu mode={mode} balancePts={balancePts} />}
        mobileDrawer={<MobileDrawer mode={mode} balancePts={balancePts} />}
        headerActions={<MobileHeaderActions mode={mode} signedIn={s.viewer !== null} />}
        rightRailSlot={<RightRail mode={mode} />}
        mobileFab={
          s.route === "Home" ? (
            <Button
              size="icon"
              shape="pill"
              aria-label="Compose post"
              onClick={() => storeActions.openComposeDialog(null)}
              className="size-13 shadow-lg"
            >
              <PenIcon className="size-5" />
            </Button>
          ) : undefined
        }
        bottomBanner={bannerVisible ? <VisitorBanner /> : undefined}
      >
        <ActiveRouteScreen mode={mode} />
      </AppShell>

      <ToastViewport>
        {s.toasts.length > 0
          ? s.toasts.map((toast) => (
              <ToastBanner
                key={toast.id}
                message={toast.message}
                description={toast.description}
                tone={toast.tone}
                onDismiss={() => storeActions.dismissToast(toast.id)}
              />
            ))
          : null}
      </ToastViewport>

      <GlobalDialogs />

      <JoinSheet
        open={s.joinSheetOpen}
        onOpenChange={storeActions.setJoinSheetOpen}
        trigger={<button type="button" hidden aria-hidden="true" tabIndex={-1} />}
        activeTab={s.joinTab}
        onTabChange={storeActions.setJoinTab}
        phoneStep={s.joinPhoneStep}
        onPhoneStepChange={storeActions.setJoinPhoneStep}
        pendingActionLabel={s.pendingAction?.label}
        skillPrompt={s.skills.prompt}
        launchers={s.skills.hosts.map((h) => h.launcher)}
        turnstileSiteKey={s.turnstileSiteKey ?? undefined}
        devSmsCodeEnabled={s.devSmsCodeEnabled}
        onFillDevCode={(rawPhone) => {
          const phoneE164 = s.pendingPhoneE164 || storeActions.formatPhoneToE164("US", rawPhone);
          return storeActions.fetchLoopbackCode(phoneE164);
        }}
        onRequestSmsCode={({ country, phone, turnstileToken }) => { void storeActions.requestSmsCode(country, phone, turnstileToken); }}
        onVerifySmsCode={(code) => { void storeActions.verifySmsCode(code); }}
        onResendSmsCode={() => { void storeActions.resendSmsCode(); }}
        onCompleteProfile={(payload) => { void storeActions.completePhoneOnboard(payload); }}
        onLaunchHost={storeActions.launchAgentHost}
        onCopySkillPrompt={storeActions.copySkillPrompt}
        onSubmitReviewer={(payload) => { void storeActions.submitReviewerLogin(payload); }}
        loading={s.joinLoading}
        error={s.joinError ?? undefined}
      />
    </>
  );
}
