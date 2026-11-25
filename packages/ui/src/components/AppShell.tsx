import type { ComponentProps, ReactNode } from "react";
import { Bell, Compass, HelpCircle, LineChart, MessageSquare, Settings, TrendingUp, Trophy, User } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { BrandMark, HouseIcon } from "./BrandMark.tsx";
import { Button } from "./Button.tsx";
import type { UiMode } from "./ModeToggle.tsx";

export type AppNavRoute = "Home" | "Explore" | "Markets" | "Leaderboard" | "Chats" | "Notifications" | "Profile" | "Settings" | "HowToPlay";

export type AppShellLayout = "social" | "wide";

export interface TrendingItem {
  /** Stable identifier for the trending topic or market mover. */
  id: string;
  /** Headline or ticker shown in the trending rail. */
  title: string;
  /** Optional category or secondary metadata. */
  subtitle?: string;
  /** Optional numeric metric such as odds or 24h change; hidden in SocialMode when marked financial. */
  metric?: string;
  /** Marks market movers that must be hidden in SocialMode. */
  financial?: boolean;
}

export type AppShellProps = Omit<ComponentProps<"div">, "children"> & {
  /** Active navigation route highlighted in both desktop rail and mobile bottom bar. */
  route: AppNavRoute;
  /** Optional override for the highlighted nav item; pass `null` on detail pages so no primary tab is force-highlighted. */
  activeRoute?: AppNavRoute | null;
  /** Optional mobile header title overriding the route label. */
  headerTitle?: string;
  /** Current presentation mode (`SocialMode` hides Markets, Leaderboard, balances, and financial movers). */
  mode: UiMode;
  /** Whether a player session is active; hides auth-only destinations when false. */
  signedIn: boolean;
  /** Center column layout (`social` constrains to 600px with right rail; `wide` expands and hides right rail). */
  layout?: AppShellLayout;
  /** Unread notification badge count. */
  unreadNotifications?: number;
  /** Unread chat thread badge count. */
  unreadChats?: number;
  /** Formatted virtual points balance shown in header when signed in and in `GameMode`. */
  balancePts?: string;
  /** Called when a navigation destination is activated. */
  onNavigate?: (route: AppNavRoute) => void;
  /** Opens the `JoinSheet` sign-in flow when logged out. */
  onSignInClick?: () => void;
  /** Optional trending topics and movers rendered in the desktop right rail. */
  trendingItems?: TrendingItem[];
  /** Called when a trending item is clicked. */
  onSelectTrending?: (id: string) => void;
  /** Optional brand mark rendered at the top of the left rail. */
  brand?: ReactNode;
  /** Optional primary compose CTA rendered below the desktop navigation list. */
  composeAction?: ReactNode;
  /** Optional mode switch slot placed in the header/rail. */
  modeControl?: ReactNode;
  /** Optional account menu rendered in the footer of the desktop left rail. */
  accountMenu?: ReactNode;
  /** Optional header actions slot (such as profile chip or sign-out menu). */
  headerActions?: ReactNode;
  /** Hides the built-in desktop sticky header so screens can render a single sticky 53px header. */
  hideDesktopHeader?: boolean;
  /** Custom right rail content overriding the default trending list. */
  rightRail?: ReactNode;
  /** Alias for `rightRail` slot rendered in the sticky 350px right column. */
  rightRailSlot?: ReactNode;
  /** Optional drawer trigger or slot rendered on the left of the mobile header. */
  mobileDrawer?: ReactNode;
  /** Optional floating action button shown above the mobile bottom bar. */
  mobileFab?: ReactNode;
  /** Optional sticky bottom sign-in banner for logged-out visitors. */
  bottomBanner?: ReactNode;
  /** Primary route content rendered inside `<main>`. */
  children: ReactNode;
  /** Disables navigation controls. */
  disabled?: boolean;
};

type NavIcon = typeof Compass;

const navConfig: { id: AppNavRoute; label: string; href: string; icon?: NavIcon; authOnly?: boolean; gameOnly?: boolean; mobile?: boolean }[] = [
  { id: "Home", label: "Home", href: "/", mobile: true },
  { id: "Explore", label: "Explore", href: "/explore", icon: Compass, mobile: true },
  { id: "Markets", label: "Markets", href: "/markets", icon: LineChart, gameOnly: true, mobile: true },
  { id: "Leaderboard", label: "Leaderboard", href: "/leaderboard", icon: Trophy, gameOnly: true },
  { id: "Chats", label: "Chats", href: "/chats", icon: MessageSquare, authOnly: true, mobile: true },
  { id: "Notifications", label: "Notifications", href: "/notifications", icon: Bell, authOnly: true, mobile: true },
  { id: "Profile", label: "Profile", href: "/profile", icon: User, authOnly: true },
  { id: "Settings", label: "Settings", href: "/settings", icon: Settings, authOnly: true },
  { id: "HowToPlay", label: "How to Play", href: "/how-to-play", icon: HelpCircle },
];

type NavItemConfig = (typeof navConfig)[number];

function NavIconMark({ item, active, className }: { readonly item: NavItemConfig; readonly active: boolean; readonly className: string }) {
  if (item.id === "Home") {
    return <HouseIcon active={active} className={className} />;
  }
  const Icon = item.icon ?? Compass;
  return <Icon aria-hidden className={className} strokeWidth={active ? 2.4 : 1.9} />;
}

function UnreadDot({ count }: { readonly count: number }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span className="pointer-events-none absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-feed-brand px-1 text-[10px] leading-none font-bold text-feed-brand-foreground tabular-nums">
      {label}
    </span>
  );
}

function NavItemButton({
  item,
  activeRoute,
  disabled,
  onNavigate,
  variant,
  count = 0,
}: {
  readonly item: NavItemConfig;
  readonly activeRoute: AppNavRoute | null;
  readonly disabled: boolean;
  readonly onNavigate?: (route: AppNavRoute) => void;
  readonly variant: "rail" | "mobile";
  readonly count?: number;
}) {
  const active = activeRoute === item.id;
  const isRail = variant === "rail";

  return (
    <button
      type="button"
      disabled={disabled}
      data-href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        if (!disabled) onNavigate?.(item.id);
      }}
      className={cn(
        focusRing,
        inactive,
        isRail
          ? "group flex items-center justify-center rounded-full px-3 py-2.5 text-lg transition-colors duration-fast hover:bg-accent lg:w-fit lg:justify-start lg:px-3.5"
          : "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1.5 py-1.5 text-[11px] font-medium",
        isRail
          ? active
            ? "font-bold text-foreground"
            : "font-normal text-foreground/85 hover:text-foreground"
          : active
            ? "font-semibold text-foreground"
            : "text-muted-foreground hover:text-foreground",
      )}
    >
      {isRail ? (
        <span className="flex items-center gap-4">
          <span className="relative inline-flex shrink-0">
            <NavIconMark item={item} active={active} className="size-6" />
            <UnreadDot count={count} />
          </span>
          <span className="sr-only lg:not-sr-only">{item.label}</span>
        </span>
      ) : (
        <>
          <span className="relative inline-flex">
            <NavIconMark item={item} active={active} className="size-5" />
            <UnreadDot count={count} />
          </span>
          <span className="sr-only max-w-full truncate sm:not-sr-only">{item.label}</span>
        </>
      )}
    </button>
  );
}

function DefaultTrendingRail({
  isSocial,
  visibleTrending,
  disabled,
  onSelectTrending,
}: {
  readonly isSocial: boolean;
  readonly visibleTrending: TrendingItem[];
  readonly disabled: boolean;
  readonly onSelectTrending?: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
        <TrendingUp aria-hidden className="size-4 text-primary" />
        {isSocial ? "Trending on Feed" : "Trending & Movers"}
      </h2>
      {visibleTrending.length === 0 ? (
        <p className="text-sm text-muted-foreground">No trending items right now.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {visibleTrending.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onSelectTrending?.(item.id);
              }}
              className={cn(
                focusRing,
                inactive,
                "flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-fast hover:bg-accent",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-foreground">{item.title}</span>
                {item.subtitle ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.subtitle.replace(/\b1 posts\b/giu, "1 post")}
                  </span>
                ) : null}
              </span>
              {item.metric && !isSocial ? <span className="shrink-0 font-mono text-xs font-semibold text-primary tabular-nums">{item.metric}</span> : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Responsive X-style three-column Feed shell with collapsible left rail, sticky right rail, mobile bottom bar, and SocialMode filtering. */
export function AppShell({
  route,
  activeRoute,
  headerTitle,
  mode,
  signedIn,
  layout = "social",
  unreadNotifications = 0,
  unreadChats = 0,
  balancePts,
  onNavigate,
  onSignInClick,
  trendingItems = [],
  onSelectTrending,
  brand,
  composeAction,
  modeControl,
  accountMenu,
  headerActions,
  hideDesktopHeader = false,
  rightRail,
  rightRailSlot,
  mobileDrawer,
  mobileFab,
  bottomBanner,
  children,
  disabled = false,
  className,
  ...props
}: AppShellProps) {
  const isSocial = mode === "SocialMode";
  const isWide = layout === "wide";
  const highlightedRoute = activeRoute === undefined ? route : activeRoute;
  const resolvedTitle = headerTitle ?? navConfig.find((item) => item.id === route)?.label ?? route;
  const visibleItems = navConfig.filter((item) => (!item.authOnly || signedIn) && (!item.gameOnly || !isSocial));
  const mobileItems = visibleItems.filter((item) => item.mobile).slice(0, 5);
  const visibleTrending = trendingItems.filter((item) => !isSocial || !item.financial);
  const resolvedRightRail = rightRailSlot ?? rightRail;
  const badgeCount = (id: AppNavRoute) => (id === "Notifications" ? unreadNotifications : id === "Chats" ? unreadChats : 0);

  return (
    <div className={cn("min-h-screen bg-background text-foreground", className)} {...props}>
      <div className={cn("mx-auto flex w-full max-w-7xl", !isWide && "justify-center")}>
        <div className="sticky top-0 hidden h-screen shrink-0 flex-col justify-between px-2 py-3 md:flex md:w-20 lg:w-60 lg:px-3 xl:w-64">
          <div className="flex flex-col items-center gap-4 lg:items-stretch">
            <div className="flex items-center justify-center px-2 py-1 lg:justify-start">
              {brand ?? (
                <>
                  <BrandMark variant="icon" className="size-8 text-feed-brand lg:hidden" />
                  <BrandMark variant="logo" className="hidden h-7 w-auto text-foreground lg:block" />
                </>
              )}
            </div>
            <nav aria-label="Primary" className="flex flex-col items-center gap-1 lg:items-stretch">
              {visibleItems.map((item) => (
                <NavItemButton
                  key={item.id}
                  item={item}
                  activeRoute={highlightedRoute}
                  disabled={disabled}
                  onNavigate={onNavigate}
                  variant="rail"
                  count={badgeCount(item.id)}
                />
              ))}
            </nav>
            {composeAction ? <div className="w-full px-1 pt-1">{composeAction}</div> : null}
          </div>

          <div className="flex flex-col items-center gap-3 lg:items-stretch">
            {modeControl ? <div className="hidden lg:block">{modeControl}</div> : null}
            {accountMenu}
            {!signedIn ? (
              <Button shape="pill" disabled={disabled} onClick={() => !disabled && onSignInClick?.()} className="w-full">
                <span className="hidden lg:inline">Sign in</span>
                <span className="lg:hidden">Join</span>
              </Button>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col pb-16 md:pb-0",
            isWide ? "md:border-l md:border-border" : "max-w-[600px] md:border-x md:border-border",
          )}
        >
          <header
            className={cn(
              "sticky top-0 z-30 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md",
              hideDesktopHeader && "md:hidden",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              {mobileDrawer ? <div className="md:hidden">{mobileDrawer}</div> : null}
              {!mobileDrawer ? (
                <span className="inline-flex items-center font-bold text-foreground md:hidden">
                  {brand ?? <BrandMark variant="icon" className="size-6 text-feed-brand" />}
                </span>
              ) : null}
              <h1 className="truncate text-base font-bold text-foreground">{resolvedTitle}</h1>
            </div>
            <div className="flex items-center gap-2">
              {signedIn && !isSocial && balancePts ? (
                <Badge variant="outline" className="font-mono tabular-nums">
                  {balancePts}
                </Badge>
              ) : null}
              {headerActions}
              {signedIn ? (
                <Button
                  size="icon"
                  shape="pill"
                  variant={highlightedRoute === "Settings" ? "secondary" : "ghost"}
                  aria-label="Settings"
                  aria-current={highlightedRoute === "Settings" ? "page" : undefined}
                  disabled={disabled}
                  onClick={() => !disabled && onNavigate?.("Settings")}
                  className="md:hidden"
                >
                  <Settings aria-hidden className="size-4" />
                </Button>
              ) : null}
              {!signedIn && !headerActions ? (
                <Button size="sm" shape="pill" disabled={disabled} onClick={() => !disabled && onSignInClick?.()}>
                  Sign in
                </Button>
              ) : null}
            </div>
          </header>

          <main className="flex min-w-0 flex-1 flex-col">{children}</main>

          {bottomBanner ? <div className="sticky bottom-16 z-20 p-3 md:bottom-0">{bottomBanner}</div> : null}
        </div>

        {!isWide ? (
          <aside aria-label="Trending" className="sticky top-0 hidden h-screen w-[350px] shrink-0 flex-col gap-4 overflow-y-auto px-5 py-3 xl:flex">
            {resolvedRightRail ?? (
              <DefaultTrendingRail
                isSocial={isSocial}
                visibleTrending={visibleTrending}
                disabled={disabled}
                onSelectTrending={onSelectTrending}
              />
            )}
          </aside>
        ) : null}
      </div>

      {mobileFab ? <div className="fixed right-4 bottom-20 z-30 md:hidden">{mobileFab}</div> : null}

      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border bg-background/95 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur-md md:hidden"
      >
        {mobileItems.map((item) => (
          <NavItemButton
            key={item.id}
            item={item}
            activeRoute={highlightedRoute}
            disabled={disabled}
            onNavigate={onNavigate}
            variant="mobile"
            count={badgeCount(item.id)}
          />
        ))}
      </nav>
    </div>
  );
}
