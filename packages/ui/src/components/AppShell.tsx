import type { ComponentProps, ReactNode } from "react";
import { Bell, Compass, HelpCircle, Home, LineChart, MessageSquare, Settings, TrendingUp, User } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./Card.tsx";
import type { UiMode } from "./ModeToggle.tsx";

export type AppNavRoute = "Home" | "Explore" | "Markets" | "Chats" | "Notifications" | "Profile" | "Settings" | "HowToPlay";

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
  /** Current presentation mode (`SocialMode` hides Markets, balances, and financial movers). */
  mode: UiMode;
  /** Whether a player session is active; hides auth-only destinations when false. */
  signedIn: boolean;
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
  /** Optional mode switch slot placed in the header/rail. */
  modeControl?: ReactNode;
  /** Optional header actions slot (such as profile chip or sign-out menu). */
  headerActions?: ReactNode;
  /** Custom right rail content overriding the default trending list. */
  rightRail?: ReactNode;
  /** Optional sticky bottom sign-in banner for logged-out visitors. */
  bottomBanner?: ReactNode;
  /** Primary route content rendered inside `<main>`. */
  children: ReactNode;
  /** Disables navigation controls. */
  disabled?: boolean;
};

const navConfig: { id: AppNavRoute; label: string; icon: typeof Home; authOnly?: boolean; gameOnly?: boolean; mobile?: boolean }[] = [
  { id: "Home", label: "Home", icon: Home, mobile: true },
  { id: "Explore", label: "Explore", icon: Compass, mobile: true },
  { id: "Markets", label: "Markets", icon: LineChart, gameOnly: true, mobile: true },
  { id: "Chats", label: "Chats", icon: MessageSquare, authOnly: true, mobile: true },
  { id: "Notifications", label: "Notifications", icon: Bell, authOnly: true, mobile: true },
  { id: "Profile", label: "Profile", icon: User, authOnly: true },
  { id: "Settings", label: "Settings", icon: Settings, authOnly: true },
  { id: "HowToPlay", label: "How to Play", icon: HelpCircle, mobile: true },
];

type NavItemConfig = (typeof navConfig)[number];

function NavItemButton({
  item,
  route,
  disabled,
  onNavigate,
  variant,
  count = 0,
}: {
  readonly item: NavItemConfig;
  readonly route: AppNavRoute;
  readonly disabled: boolean;
  readonly onNavigate?: (route: AppNavRoute) => void;
  readonly variant: "rail" | "mobile";
  readonly count?: number;
}) {
  const Icon = item.icon;
  const active = route === item.id;
  const isRail = variant === "rail";

  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        if (!disabled) onNavigate?.(item.id);
      }}
      className={cn(
        focusRing,
        inactive,
        isRail
          ? "flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-fast"
          : "flex min-w-14 flex-col items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium",
        isRail
          ? active
            ? "bg-accent font-semibold text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
          : active
            ? "text-primary"
            : "text-muted-foreground",
      )}
    >
      {isRail ? (
        <>
          <span className="flex items-center gap-3">
            <Icon aria-hidden className="size-4.5" />
            {item.label}
          </span>
          {count > 0 ? <Badge variant="default">{count}</Badge> : null}
        </>
      ) : (
        <>
          <Icon aria-hidden className="size-4" />
          <span>{item.label}</span>
        </>
      )}
    </button>
  );
}

/** Responsive three-column Feed shell with desktop left rail, mobile bottom bar, right trending rail, and SocialMode filtering. */
export function AppShell({
  route,
  mode,
  signedIn,
  unreadNotifications = 0,
  unreadChats = 0,
  balancePts,
  onNavigate,
  onSignInClick,
  trendingItems = [],
  onSelectTrending,
  brand,
  modeControl,
  headerActions,
  rightRail,
  bottomBanner,
  children,
  disabled = false,
  className,
  ...props
}: AppShellProps) {
  const isSocial = mode === "SocialMode";
  const visibleItems = navConfig.filter((item) => (!item.authOnly || signedIn) && (!item.gameOnly || !isSocial));
  const mobileItems = visibleItems.filter((item) => item.mobile).slice(0, 5);
  const visibleTrending = trendingItems.filter((item) => !isSocial || !item.financial);

  const badgeCount = (id: AppNavRoute) => (id === "Notifications" ? unreadNotifications : id === "Chats" ? unreadChats : 0);

  return (
    <div className={cn("min-h-screen bg-background text-foreground", className)} {...props}>
      <div className="mx-auto flex w-full max-w-7xl">
        <div className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col justify-between border-r border-border p-4 md:flex lg:w-64">
          <div className="flex flex-col gap-6">
            <div className="px-2">
              {brand ?? <span className="text-xl font-bold tracking-tight text-foreground">Feed</span>}
            </div>
            <nav aria-label="Primary" className="flex flex-col gap-1">
              {visibleItems.map((item) => (
                <NavItemButton
                  key={item.id}
                  item={item}
                  route={route}
                  disabled={disabled}
                  onNavigate={onNavigate}
                  variant="rail"
                  count={badgeCount(item.id)}
                />
              ))}
            </nav>
          </div>
          <div className="flex flex-col gap-3">
            {modeControl}
            {!signedIn ? (
              <Button disabled={disabled} onClick={() => !disabled && onSignInClick?.()}>
                Sign in
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col pb-16 md:border-r md:border-border md:pb-0">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <span className="font-bold text-foreground md:hidden">{brand ?? "Feed"}</span>
              <h1 className="text-base font-semibold text-foreground">{navConfig.find((item) => item.id === route)?.label ?? route}</h1>
            </div>
            <div className="flex items-center gap-2">
              {signedIn && !isSocial && balancePts ? (
                <Badge variant="outline" className="font-mono tabular-nums">
                  {balancePts}
                </Badge>
              ) : null}
              {headerActions}
              {!signedIn && !headerActions ? (
                <Button size="sm" disabled={disabled} onClick={() => !disabled && onSignInClick?.()}>
                  Sign in
                </Button>
              ) : null}
            </div>
          </header>

          <main className="flex min-w-0 flex-1 flex-col">{children}</main>

          {bottomBanner ? <div className="sticky bottom-16 z-20 p-3 md:bottom-0">{bottomBanner}</div> : null}
        </div>

        <aside aria-label="Trending" className="hidden w-80 shrink-0 flex-col gap-4 p-4 xl:flex">
          {rightRail ?? (
            <Card className="gap-3 p-4">
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TrendingUp aria-hidden className="size-4 text-primary" />
                  {isSocial ? "Trending on Feed" : "Trending & Movers"}
                </CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                {visibleTrending.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No trending items right now.</p>
                ) : (
                  visibleTrending.map((item) => (
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
                        "flex items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                        {item.subtitle ? <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span> : null}
                      </span>
                      {item.metric && !isSocial ? <span className="shrink-0 font-mono text-xs font-semibold text-primary tabular-nums">{item.metric}</span> : null}
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border bg-background/95 px-2 py-1.5 backdrop-blur-sm md:hidden">
        {mobileItems.map((item) => (
          <NavItemButton
            key={item.id}
            item={item}
            route={route}
            disabled={disabled}
            onNavigate={onNavigate}
            variant="mobile"
          />
        ))}
      </nav>
    </div>
  );
}
