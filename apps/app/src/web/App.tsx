// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"; spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useId } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  CardContent,
  JoinSheet,
  Label,
  Switch,
  type UiMode,
  formatPts,
} from "@repo/ui";
import { initial as appInitial } from "../../gen/app.ts";
import { useMachine as useAppMachine } from "../../gen/app.react.ts";
import {
  type NavState,
  initial as navInitial,
  showBottomBanner,
  visibleSurfaces,
} from "../../gen/app__navigation.ts";
import { useMachine as useNavMachine } from "../../gen/app__navigation.react.ts";
import { initial as onboardingInitial } from "../../gen/app__onboarding.ts";
import { useMachine as useOnboardingMachine } from "../../gen/app__onboarding.react.ts";
import { toAppNavRoute } from "./routes.ts";
import { AdminScreen, LinkScreen, OAuthConsentScreen } from "./screens/AuthScreens.tsx";
import { ChatsScreen } from "./screens/ChatsScreen.tsx";
import { ExploreScreen } from "./screens/ExploreScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { HowToPlayScreen } from "./screens/HowToPlayScreen.tsx";
import { MarketsScreen } from "./screens/MarketsScreen.tsx";
import { NotificationsScreen } from "./screens/NotificationsScreen.tsx";
import { ProfileScreen } from "./screens/ProfileScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { currentUiMode, toSpecTab } from "./store-core.ts";
import { appRuntime, navRuntime, onboardingRuntime, storeActions, useAppStore } from "./store.ts";

function RailModeControl({
  mode,
  showAtRiskNotice,
}: {
  readonly mode: UiMode;
  readonly showAtRiskNotice: boolean;
}) {
  const switchId = useId();
  const isSocial = mode === "SocialMode";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={switchId} className="text-xs font-medium">
          Social mode
        </Label>
        <Switch
          id={switchId}
          checked={isSocial}
          onCheckedChange={(checked) => {
            storeActions.toggleUiModeFromControl(checked ? "SocialMode" : "GameMode");
          }}
        />
      </div>
      {showAtRiskNotice ? (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-warn">
          <span>Open positions at risk</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => storeActions.toggleUiModeFromControl("GameMode")}
          >
            Game
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HeaderActions({
  mode,
  handle,
  isAdmin,
}: {
  readonly mode: UiMode;
  readonly handle: string | null;
  readonly isAdmin: boolean;
}) {
  const nextMode: UiMode = mode === "SocialMode" ? "GameMode" : "SocialMode";

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="md:hidden"
        onClick={() => storeActions.toggleUiModeFromControl(nextMode)}
      >
        {mode === "SocialMode" ? "Social" : "Game"}
      </Button>
      {handle ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(handle)}`); }}
        >
          @{handle}
        </Button>
      ) : (
        <Button
          size="sm"
          className="md:hidden"
          onClick={() => storeActions.openJoinSheet("phone")}
        >
          Sign in
        </Button>
      )}
      {isAdmin ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => { void storeActions.navigate("/admin"); }}
        >
          Admin
        </Button>
      ) : null}
    </div>
  );
}

function VisitorBanner() {
  return (
    <Card className="border-primary/40 bg-card/95 shadow-md backdrop-blur-sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">Join Feed with 100 virtual pts</span>
          <span className="text-xs text-muted-foreground">
            Sign in with your phone or connect one AI agent from SKILL.md. Virtual points have no cash value.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => storeActions.openJoinSheet("agent")}>
            Connect Agent
          </Button>
          <Button size="sm" onClick={() => storeActions.openJoinSheet("phone")}>
            Sign in
          </Button>
          <Button size="sm" variant="ghost" onClick={storeActions.dismissBottomBanner}>
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NoticeStrip({
  statusMessage,
  errorMessage,
  hostActionNote,
}: {
  readonly statusMessage: string | null;
  readonly errorMessage: string | null;
  readonly hostActionNote: string | null;
}) {
  if (!statusMessage && !errorMessage && !hostActionNote) return null;

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2">
      {errorMessage ? (
        <Alert
          variant="destructive"
          action={<Button size="sm" variant="ghost" onClick={storeActions.clearNotices}>Dismiss</Button>}
        >
          {errorMessage}
        </Alert>
      ) : null}
      {statusMessage ? (
        <Alert
          variant="ok"
          action={<Button size="sm" variant="ghost" onClick={storeActions.clearNotices}>Dismiss</Button>}
        >
          {statusMessage}
        </Alert>
      ) : null}
      {hostActionNote ? <Alert variant="info">{hostActionNote}</Alert> : null}
    </div>
  );
}

function ActiveRouteScreen({
  mode,
  explainerVisible,
}: {
  readonly mode: UiMode;
  readonly explainerVisible: boolean;
}) {
  const s = useAppStore();

  switch (s.route) {
    case "Home":
      return <HomeScreen mode={mode} explainerVisible={explainerVisible} />;
    case "Explore":
      return <ExploreScreen mode={mode} />;
    case "Markets":
      return mode === "SocialMode"
        ? <HomeScreen mode={mode} explainerVisible={explainerVisible} />
        : <MarketsScreen />;
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
  const appMachine = useAppMachine(appRuntime);
  const navMachine = useNavMachine(navRuntime);
  const onboardingMachine = useOnboardingMachine(onboardingRuntime);

  const mode = currentUiMode(s);
  const hasAtRiskOpenPositions = s.positions.some((p) => !p.isClosed);
  const baseNav = navMachine.state ?? navInitial;
  const effectiveNavState: NavState = {
    ...baseNav,
    route: s.route,
    feedTab: toSpecTab(s.feedTab),
    uiMode: mode,
    signedIn: s.viewer !== null,
    isAdmin: s.viewer?.isAdmin ?? false,
    scrolledDeep: s.scrolledDeep,
    itemsViewed: s.itemsViewed,
    bannerDismissed: s.bannerDismissed,
    hasAtRiskOpenPositions,
  };
  const surfaces = visibleSurfaces(effectiveNavState);
  const bannerVisible = showBottomBanner(effectiveNavState);
  const appSnap = appMachine.state ?? appInitial;
  const onbSnap = onboardingMachine.state ?? onboardingInitial;
  const explainerVisible = !s.explainerDismissed && onbSnap.explainerCardVisible && appSnap.onb.explainerCardVisible;
  const unreadChats = s.chats.reduce((acc, c) => acc + c.unreadCount, 0) + s.alphaInvites.length;
  const balancePts = s.viewer && surfaces.showBalances ? formatPts(s.viewer.balanceCents / 100) : undefined;

  const handleSelectTrending = (id: string) => {
    const found = s.explore.trending.find((item) => item.id === id);
    if (found?.financial && mode === "GameMode") {
      const ticker = found.title.replace(/^\$/, "");
      void storeActions.navigate(`/markets?ticker=${encodeURIComponent(ticker)}`);
      return;
    }
    void storeActions.loadExplore(found?.title ?? "");
    void storeActions.navigate("/explore");
  };

  return (
    <>
      <AppShell
        route={toAppNavRoute(s.route)}
        mode={mode}
        signedIn={s.viewer !== null}
        unreadNotifications={s.unreadNotifications}
        unreadChats={unreadChats}
        balancePts={balancePts}
        trendingItems={[...s.explore.trending]}
        onSelectTrending={handleSelectTrending}
        onNavigate={storeActions.navigateRoute}
        onSignInClick={() => storeActions.openJoinSheet("phone")}
        brand={
          <button
            type="button"
            onClick={() => { void storeActions.navigate("/"); }}
            className="flex items-center gap-2 text-left text-xl font-bold tracking-tight text-foreground"
          >
            <span>Feed</span>
            <Badge variant="outline" className="text-xs font-medium">
              {mode === "SocialMode" ? "Social" : "Markets"}
            </Badge>
          </button>
        }
        modeControl={<RailModeControl mode={mode} showAtRiskNotice={surfaces.showAtRiskPositionsNotice} />}
        headerActions={
          <HeaderActions
            mode={mode}
            handle={s.viewer?.handle ?? null}
            isAdmin={s.viewer?.isAdmin ?? false}
          />
        }
        bottomBanner={bannerVisible ? <VisitorBanner /> : undefined}
      >
        <NoticeStrip
          statusMessage={s.statusMessage}
          errorMessage={s.errorMessage}
          hostActionNote={s.joinSheetOpen ? null : s.hostActionNote}
        />
        <ActiveRouteScreen mode={mode} explainerVisible={explainerVisible} />
      </AppShell>

      <JoinSheet
        open={s.joinSheetOpen}
        onOpenChange={storeActions.setJoinSheetOpen}
        trigger={<button type="button" hidden aria-hidden="true" tabIndex={-1} />}
        activeTab={s.joinTab}
        onTabChange={storeActions.setJoinTab}
        phoneStep={s.joinPhoneStep}
        pendingActionLabel={s.pendingAction?.label}
        skillPrompt={s.skills.prompt}
        launchers={s.skills.hosts.map((h) => h.launcher)}
        onRequestSmsCode={({ country, phone }) => { void storeActions.requestSmsCode(country, phone); }}
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
