// spec/app/navigation.md, "Route navigation respects public visibility, mode hiding, and auth gates"
import type { AppNavRoute } from "@repo/ui";
import type { AppRoute, PublicTarget } from "../../gen/app__navigation.ts";

export type SettingsTabId = "profile" | "appearance" | "agent" | "privacy" | "account";

export interface ParsedLocation {
  readonly route: AppRoute;
  readonly profileHandle: string | null;
  readonly postId: string | null;
  readonly articleId: string | null;
  readonly trendingTag: string | null;
  readonly exploreQuery: string | null;
  readonly queryTicker: string | null;
  readonly marketId: string | null;
  readonly marketKind: "prediction" | "perp" | null;
  readonly walletView: boolean;
  readonly settingsTab: SettingsTabId | null;
  readonly canonicalPath: string;
  readonly replaceCanonical: boolean;
}

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export function routeToPath(route: AppRoute, options?: {
  readonly profileHandle?: string | null;
  readonly postId?: string | null;
  readonly articleId?: string | null;
  readonly walletView?: boolean;
}): string {
  switch (route) {
    case "Home":
      return "/";
    case "Explore":
      return options?.articleId ? `/article/${encodeURIComponent(options.articleId)}` : "/explore";
    case "Markets":
      return options?.walletView ? "/wallet" : "/markets";
    case "Leaderboard":
      return "/leaderboard";
    case "PostDetail":
      return options?.postId ? `/post/${encodeURIComponent(options.postId)}` : "/";
    case "Chats":
      return "/chats";
    case "Notifications":
      return "/notifications";
    case "Profile":
      return options?.profileHandle ? `/u/${encodeURIComponent(options.profileHandle)}` : "/profile";
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
    case "Leaderboard":
    case "Chats":
    case "Notifications":
    case "Profile":
    case "Settings":
    case "HowToPlay":
      return route;
    case "PostDetail":
      return "Home";
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
    case "PostDetail":
      return "ViewFeed";
    case "Profile":
      return "ViewProfile";
    case "Markets":
      return "ViewMarket";
    case "Leaderboard":
      return "ViewLeaderboard";
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

function parseSettingsTab(raw: string | null): SettingsTabId | null {
  if (raw === "profile" || raw === "appearance" || raw === "agent" || raw === "privacy" || raw === "account") {
    return raw;
  }
  if (raw === "moderation") return "privacy";
  return null;
}

export function parseLocation(pathname: string, search: string): ParsedLocation {
  const cleanPath = pathname.replace(/\/+$/u, "") || "/";
  const params = new URLSearchParams(search);
  const queryTicker = params.get("ticker");
  const exploreQuery = params.get("q");
  const settingsTab = parseSettingsTab(params.get("tab"));

  const base: ParsedLocation = {
    route: "Home",
    profileHandle: null,
    postId: null,
    articleId: null,
    trendingTag: null,
    exploreQuery: null,
    queryTicker,
    marketId: null,
    marketKind: queryTicker ? "perp" : null,
    walletView: false,
    settingsTab: null,
    canonicalPath: `${cleanPath}${search}`,
    replaceCanonical: false,
  };

  if (cleanPath === "/" || cleanPath === "/feed") {
    return {
      ...base,
      route: "Home",
      canonicalPath: `/${search}`,
      replaceCanonical: cleanPath === "/feed",
    };
  }

  const postMatch = /^\/(?:post|comment)\/([^/]+)$/u.exec(cleanPath);
  if (postMatch?.[1]) {
    const postId = decodePart(postMatch[1]);
    return {
      ...base,
      route: "PostDetail",
      postId,
      canonicalPath: `/post/${encodeURIComponent(postId)}${search}`,
      replaceCanonical: cleanPath.startsWith("/comment/"),
    };
  }

  const articleMatch = /^\/article\/([^/]+)$/u.exec(cleanPath);
  if (articleMatch?.[1]) {
    const articleId = decodePart(articleMatch[1]);
    return {
      ...base,
      route: "Explore",
      articleId,
      canonicalPath: `/article/${encodeURIComponent(articleId)}${search}`,
    };
  }

  const trendingMatch = /^\/trending\/([^/]+)$/u.exec(cleanPath);
  if (trendingMatch?.[1]) {
    const tag = decodePart(trendingMatch[1]);
    return {
      ...base,
      route: "Explore",
      trendingTag: tag,
      exploreQuery: tag,
      canonicalPath: `/trending/${encodeURIComponent(tag)}`,
    };
  }

  if (cleanPath === "/explore") {
    return {
      ...base,
      route: "Explore",
      exploreQuery: exploreQuery ?? "",
    };
  }

  if (cleanPath === "/leaderboard") {
    return { ...base, route: "Leaderboard" };
  }

  if (cleanPath === "/wallet") {
    return { ...base, route: "Markets", walletView: true };
  }

  const perpMatch = /^\/markets\/perps\/([^/]+)$/u.exec(cleanPath);
  if (perpMatch?.[1]) {
    const ticker = decodePart(perpMatch[1]).toUpperCase();
    return {
      ...base,
      route: "Markets",
      queryTicker: ticker,
      marketKind: "perp",
      marketId: ticker,
    };
  }

  const predMatch = /^\/markets\/predictions\/([^/]+)$/u.exec(cleanPath);
  if (predMatch?.[1]) {
    const marketId = decodePart(predMatch[1]);
    return {
      ...base,
      route: "Markets",
      marketKind: "prediction",
      marketId,
    };
  }

  if (cleanPath === "/markets") {
    return { ...base, route: "Markets" };
  }

  if (cleanPath === "/chats") {
    return { ...base, route: "Chats" };
  }

  if (cleanPath === "/notifications") {
    return { ...base, route: "Notifications" };
  }

  if (cleanPath === "/settings/moderation") {
    return {
      ...base,
      route: "Settings",
      settingsTab: "privacy",
      canonicalPath: "/settings?tab=privacy",
      replaceCanonical: true,
    };
  }

  if (cleanPath === "/settings") {
    return { ...base, route: "Settings", settingsTab };
  }

  if (cleanPath === "/how-to-play") {
    return { ...base, route: "HowToPlay" };
  }

  if (cleanPath === "/link") {
    return { ...base, route: "Link" };
  }

  if (cleanPath === "/oauth/authorize") {
    return { ...base, route: "OAuthConsent" };
  }

  if (cleanPath === "/admin") {
    return { ...base, route: "Admin" };
  }

  if (cleanPath === "/profile") {
    return { ...base, route: "Profile" };
  }

  const profileAliasMatch = /^\/(?:u\/id|u|actors|orgs|profile)\/([^/]+)$/u.exec(cleanPath);
  if (profileAliasMatch?.[1]) {
    const handle = decodePart(profileAliasMatch[1]).replace(/^@/, "").trim();
    return {
      ...base,
      route: "Profile",
      profileHandle: handle || null,
    };
  }

  return { ...base, route: "Home", canonicalPath: "/" };
}
