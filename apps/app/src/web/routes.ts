// spec/app/navigation.md, "Route navigation respects public visibility, mode hiding, and auth gates"
import type { AppNavRoute } from "@repo/ui";
import type { AppRoute, PublicTarget } from "../../gen/app__navigation.ts";

export interface ParsedLocation {
  readonly route: AppRoute;
  readonly profileHandle: string | null;
  readonly queryTicker: string | null;
  readonly pathWithSearch: string;
}

export function routeToPath(route: AppRoute, profileHandle?: string | null): string {
  switch (route) {
    case "Home":
      return "/";
    case "Explore":
      return "/explore";
    case "Markets":
      return "/markets";
    case "Chats":
      return "/chats";
    case "Notifications":
      return "/notifications";
    case "Profile":
      return profileHandle ? `/u/${encodeURIComponent(profileHandle)}` : "/profile";
    case "Settings":
      return "/settings";
    case "HowToPlay":
      return "/how-to-play";
    case "Link":
      return "/link";
    case "OAuthConsent":
      return "/oauth/authorize";
    case "Admin":
      return "/admin";
  }
}

export function toAppNavRoute(route: AppRoute): AppNavRoute {
  switch (route) {
    case "Home":
    case "Explore":
    case "Markets":
    case "Chats":
    case "Notifications":
    case "Profile":
    case "Settings":
    case "HowToPlay":
      return route;
    case "Link":
    case "OAuthConsent":
      return "Settings";
    case "Admin":
      return "Home";
  }
}

export function toPublicTarget(route: AppRoute): PublicTarget | null {
  switch (route) {
    case "Home":
    case "Explore":
      return "ViewFeed";
    case "Profile":
      return "ViewProfile";
    case "Markets":
      return "ViewMarket";
    case "HowToPlay":
      return "ViewHowToPlay";
    case "Chats":
    case "Notifications":
    case "Settings":
    case "Link":
    case "OAuthConsent":
    case "Admin":
      return null;
  }
}

export function parseLocation(pathname: string, search: string): ParsedLocation {
  const cleanPath = pathname.replace(/\/+$/u, "") || "/";
  const params = new URLSearchParams(search);
  const queryTicker = params.get("ticker");
  const pathWithSearch = `${cleanPath}${search}`;
  if (cleanPath === "/") return { route: "Home", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/explore") return { route: "Explore", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/markets") return { route: "Markets", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/chats") return { route: "Chats", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/notifications") return { route: "Notifications", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/settings") return { route: "Settings", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/how-to-play") return { route: "HowToPlay", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/link") return { route: "Link", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/oauth/authorize") return { route: "OAuthConsent", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/admin") return { route: "Admin", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath === "/profile") return { route: "Profile", profileHandle: null, queryTicker, pathWithSearch };
  if (cleanPath.startsWith("/u/")) {
    const rawHandle = decodeURIComponent(cleanPath.slice(3)).replace(/^@/, "").trim();
    return { route: "Profile", profileHandle: rawHandle || null, queryTicker, pathWithSearch };
  }
  return { route: "Home", profileHandle: null, queryTicker, pathWithSearch };
}
