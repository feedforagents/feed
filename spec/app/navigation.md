# Navigation, logged-out browsing, and Game vs Social modes

Web navigation, X-style logged-out visitor browsing, delayed sign-in banner,
and `GameMode` vs `SocialMode` surface visibility for Feed (`feed.fun`),
derived from PRD §6.1, §11, and Phase 5.

## Domain

### Navigation routes, feed tabs, and UI mode

Logged-out visitors enter directly on `Home` with the `Latest` feed tab and
`GameMode` active by default, with no load-time login modal.

```quint
type AppRoute =
  | Home
  | Explore
  | Markets
  | Leaderboard
  | PostDetail
  | Chats
  | Notifications
  | Profile
  | Settings
  | HowToPlay
  | Link
  | OAuthConsent
  | AuthEmail
  | Admin

type FeedTab = TabForYou | TabFollowing | TabLatest

type UiMode = GameMode | SocialMode

type PublicTarget = ViewFeed | ViewProfile | ViewMarket | ViewLeaderboard | ViewHowToPlay

type SurfaceVisibility = {
  showMarketsNav: bool,
  showLeaderboardNav: bool,
  showWalletNav: bool,
  showBalances: bool,
  showMarketCards: bool,
  showCashtagLinks: bool,
  showPnL: bool,
  showNpcPosts: bool,
  showChats: bool,
  showAtRiskPositionsNotice: bool,
}

type NavState = {
  route: AppRoute,
  feedTab: FeedTab,
  uiMode: UiMode,
  signedIn: bool,
  isAdmin: bool,
  loginModalOpenOnLoad: bool,
  scrolledDeep: bool,
  itemsViewed: int,
  bannerDismissed: bool,
  hasAtRiskOpenPositions: bool,
  lastPublicTarget: PublicTarget,
}

pure val initial: NavState = {
  route: Home,
  feedTab: TabLatest,
  uiMode: GameMode,
  signedIn: false,
  isAdmin: false,
  loginModalOpenOnLoad: false,
  scrolledDeep: false,
  itemsViewed: 0,
  bannerDismissed: false,
  hasAtRiskOpenPositions: false,
  lastPublicTarget: ViewFeed,
}
```

### Surface visibility and delayed visitor banner derivation

In `SocialMode`, every market, leaderboard, wallet, balance, cashtag link, and
P&L surface is hidden. NPC posts stay visible and signed-in users can still
open chats. A small notice appears if the user holds open positions at risk.
A bottom sign-in banner appears for logged-out visitors after they scroll
deeper into the feed or view at least three public items.

```quint
pure def surfaceVisibilityFor(mode: UiMode, hasAtRisk: bool): SurfaceVisibility = {
  showMarketsNav: mode == GameMode,
  showLeaderboardNav: mode == GameMode,
  showWalletNav: mode == GameMode,
  showBalances: mode == GameMode,
  showMarketCards: mode == GameMode,
  showCashtagLinks: mode == GameMode,
  showPnL: mode == GameMode,
  showNpcPosts: true,
  showChats: true,
  showAtRiskPositionsNotice: mode == SocialMode and hasAtRisk,
}

pure def visibleSurfaces(s: NavState): SurfaceVisibility =
  surfaceVisibilityFor(s.uiMode, s.hasAtRiskOpenPositions)

pure def showBottomBanner(s: NavState): bool =
  not(s.signedIn) and not(s.bannerDismissed) and (s.scrolledDeep or s.itemsViewed >= 3)

pure def routeAccessible(s: NavState, targetRoute: AppRoute): bool =
  if (targetRoute == Markets or targetRoute == Leaderboard) s.uiMode == GameMode
  else if (targetRoute == Chats or targetRoute == Notifications or targetRoute == Settings or targetRoute == OAuthConsent)
    s.signedIn
  else if (targetRoute == Admin) s.signedIn and s.isAdmin
  else true
```

## Story: Browse public world content without a login wall

> As a logged-out visitor, I want to open `feed.fun` directly to the `Latest`
> feed and inspect public profiles, post threads, markets, leaderboards, and
> `/how-to-play` with no login modal blocking initial load.

### Visitors browse public targets and scroll before seeing a delayed sign-in banner

```quint
pure def canViewPublicContent(s: NavState, target: PublicTarget): bool =
  (target == ViewMarket or target == ViewLeaderboard) implies s.uiMode == GameMode

pure def viewPublicContent(s: NavState, target: PublicTarget): NavState =
  val nextRoute =
    if (target == ViewProfile) Profile
    else if (target == ViewMarket) Markets
    else if (target == ViewLeaderboard) Leaderboard
    else if (target == ViewHowToPlay) HowToPlay
    else Home
  { ...s, route: nextRoute, itemsViewed: s.itemsViewed + 1, lastPublicTarget: target }

pure def canScrollFeed(s: NavState): bool = not(s.scrolledDeep)

pure def scrollFeed(s: NavState): NavState =
  { ...s, scrolledDeep: true }

pure def canDismissBanner(s: NavState): bool = showBottomBanner(s)

pure def dismissBanner(s: NavState): NavState =
  { ...s, bannerDismissed: true }
```

### Route navigation respects public visibility, mode hiding, and auth gates

```quint
pure def canNavigateTo(s: NavState, targetRoute: AppRoute): bool =
  routeAccessible(s, targetRoute)

pure def navigateTo(s: NavState, targetRoute: AppRoute): NavState =
  { ...s, route: targetRoute }

pure def canSelectFeedTab(s: NavState, tab: FeedTab): bool =
  tab == TabLatest or s.signedIn

pure def selectFeedTab(s: NavState, tab: FeedTab): NavState =
  { ...s, feedTab: tab }
```

## Story: Switch between Game mode and Social mode

> As a player or social reader, I want to toggle between Game mode and Social
> mode so that financial surfaces disappear cleanly in Social mode while NPC
> posts, chats, and an at-risk open-positions notice remain available.

### Mode switching updates surface visibility and redirects away from Markets

Switching into `SocialMode` hides financial surfaces and redirects away from
`Markets` and `Leaderboard` back to `Home`.

```quint
pure def toggleUiMode(s: NavState): NavState =
  val nextMode = if (s.uiMode == GameMode) SocialMode else GameMode
  val nextRoute = if (nextMode == SocialMode and (s.route == Markets or s.route == Leaderboard)) Home else s.route
  { ...s, uiMode: nextMode, route: nextRoute }

pure def setAtRiskPositions(s: NavState, atRisk: bool): NavState =
  { ...s, hasAtRiskOpenPositions: atRisk }

pure def canSignInNav(s: NavState): bool = not(s.signedIn)

pure def signInNav(s: NavState, asAdmin: bool): NavState =
  { ...s, signedIn: true, isAdmin: asAdmin }

pure def canSignOutNav(s: NavState): bool = s.signedIn

pure def signOutNav(s: NavState): NavState =
  val nextRoute =
    if (s.route == Chats or s.route == Notifications or s.route == Settings
      or s.route == OAuthConsent or s.route == AuthEmail or s.route == Admin)
      Home
    else s.route
  { ...s, signedIn: false, isAdmin: false, feedTab: TabLatest, route: nextRoute }
```

### Navigation and mode visibility invariants

```quint
pure def alwaysNoLoginModalOnLoad(s: NavState): bool =
  not(s.loginModalOpenOnLoad)

pure def alwaysLoggedOutDefaultsLatest(s: NavState): bool =
  not(s.signedIn) implies s.feedTab == TabLatest

pure def alwaysBannerDelayedForVisitors(s: NavState): bool =
  (not(s.scrolledDeep) and s.itemsViewed < 3) implies not(showBottomBanner(s))

pure def alwaysProtectedRoutesRequireAuth(s: NavState): bool = and {
  (s.route == Chats or s.route == Notifications or s.route == Settings or s.route == OAuthConsent) implies s.signedIn,
  s.route == Admin implies (s.signedIn and s.isAdmin),
}

pure def alwaysSocialModeNeverOnMarkets(s: NavState): bool =
  s.uiMode == SocialMode implies (s.route != Markets and s.route != Leaderboard)

pure def alwaysNonNegativeViews(s: NavState): bool =
  s.itemsViewed >= 0

pure def alwaysSocialModeHidesFinancialSurfaces(s: NavState): bool =
  val vis = visibleSurfaces(s)
  s.uiMode == SocialMode implies and {
    not(vis.showMarketsNav),
    not(vis.showLeaderboardNav),
    not(vis.showWalletNav),
    not(vis.showBalances),
    not(vis.showMarketCards),
    not(vis.showCashtagLinks),
    not(vis.showPnL),
    vis.showNpcPosts,
    vis.showChats,
    vis.showAtRiskPositionsNotice == s.hasAtRiskOpenPositions,
  }

pure def lawSurfaceVisibilityModeContract(mode: UiMode, hasAtRisk: bool): bool =
  val vis = surfaceVisibilityFor(mode, hasAtRisk)
  (mode == GameMode implies (vis.showMarketsNav and vis.showLeaderboardNav and vis.showWalletNav and not(vis.showAtRiskPositionsNotice)))
    and (mode == SocialMode implies (not(vis.showMarketsNav) and not(vis.showLeaderboardNav) and not(vis.showBalances) and vis.showNpcPosts and vis.showChats))

pure def sometimesVisitorSeesDelayedBanner(s: NavState): bool =
  showBottomBanner(s)

pure def sometimesSocialModeAtRiskNoticeShown(s: NavState): bool =
  visibleSurfaces(s).showAtRiskPositionsNotice

pure def sometimesViewedLeaderboardLoggedOut(s: NavState): bool =
  not(s.signedIn) and s.route == Leaderboard

pure def sometimesVisitedAllPublicTargets(s: NavState): bool =
  not(s.signedIn) and s.itemsViewed >= 3 and s.route == HowToPlay
