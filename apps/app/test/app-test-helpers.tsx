// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { App } from "../src/web/App.tsx";
import type { ViewerSession } from "../src/web/types.ts";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

export const eventSources: EventTarget[] = [];

export type MockResponder = (path: string, url: URL, init?: RequestInit) => unknown;

export function makeViewerSession(overrides: Partial<ViewerSession> = {}): ViewerSession {
  return {
    accountId: "alice",
    handle: "alice",
    displayName: "Alice Player",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: null,
    phoneVerifiedAt: null,
    emailMasked: null,
    emailVerifiedAt: null,
    uiMode: "game",
    balanceCents: 0,
    startingGrantCents: 0,
    isAdmin: false,
    isReviewer: false,
    agentGrant: null,
    ...overrides,
  };
}

export function makeRawPost(createdAt: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "post-x",
    authorId: "alice",
    authorKind: "user",
    authorHandle: "alice",
    authorDisplayName: "Alice Player",
    content: "Alice market note",
    replyToPostId: null,
    quotePostId: null,
    quotePost: null,
    repostedByHandle: null,
    repostedByName: null,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt,
    ...overrides,
  };
}

export function makeRawDirectChat(id: string, peerId: string, peerName: string): Record<string, unknown> {
  const member = (memberId: string, displayName: string) => ({
    memberId,
    memberKind: "user",
    handle: memberId,
    displayName,
    avatarUrl: null,
    role: "member",
  });
  return {
    id,
    kind: "direct",
    title: peerName,
    unreadCount: 0,
    members: [member("alice", "Alice"), member(peerId, peerName)],
  };
}

export function makeRawProfileBundle(input: {
  readonly handle: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly postsCount: number;
  readonly posts: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    profile: {
      id: input.handle,
      kind: "user",
      handle: input.handle,
      displayName: input.displayName,
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt: input.createdAt,
      followersCount: 0,
      followingCount: 0,
      postsCount: input.postsCount,
      viewerFollows: false,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerBlockedBy: false,
      viewerMutes: false,
      isParody: false,
    },
    posts: input.posts,
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  };
}

export function requestUrl(input: RequestInfo | URL, base = window.location.origin): URL {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, base);
}

export function stubFetchByUrl(
  handler: (url: URL, init?: RequestInit) => Promise<Response>,
  base = window.location.origin,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(requestUrl(input, base), init)),
  );
}

export function installStubEventSource(target: EventTarget[] = eventSources): void {
  class StubEventSource extends EventTarget {
    constructor() {
      super();
      target.push(this);
    }
    close(): void {
      const idx = target.indexOf(this);
      if (idx >= 0) target.splice(idx, 1);
    }
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

export function makeAuthMeResponse(overrides: Partial<ViewerSession> = {}): Record<string, unknown> {
  return {
    authenticated: true,
    viewer: makeViewerSession({
      accountId: "acct-player-1",
      displayName: "Alice Trader",
      phoneLast2: "01",
      balanceCents: 10500,
      startingGrantCents: 10000,
      isReviewer: true,
      ...overrides,
    }),
    acceptedCountries: ["+1", "+44"],
    publicAppUrl: window.location.origin,
    devSmsCodeEnabled: true,
  };
}

export function findButtonByText(text: string, root: ParentNode = document): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

export async function setControlValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  act(() => {
    descriptor?.set?.bind(el)(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

export function installMockNetwork(respond: MockResponder): void {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const emptyFeed = { items: [], nextCursor: null };
  const defaults: Readonly<Record<string, () => unknown>> = {
    "/api/feed": () => emptyFeed,
    "/api/posts": () => emptyFeed,
    "/api/trending": () => ({ trending: [] }),
    "/api/articles": () => ({ articles: [] }),
    "/api/markets": () => ({ predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } }),
    "/api/world/status": () => ({
      currentDay: 3,
      currentHour: 14,
      phase: "active",
      gameRunning: true,
      lastTickAt: Date.now(),
      activeMarketsCount: 0,
      totalPostsCount: 0,
      activeActorsCount: 5,
    }),
    "/api/chats": () => ({ chats: [] }),
    "/api/chats/invites": () => ({ invites: [] }),
    "/api/notifications": () => ({ items: [], unreadCount: 0 }),
    "/api/moderation/blocks": () => ({ items: [] }),
    "/api/moderation/mutes": () => ({ items: [] }),
    "/api/skills/hosts": () => ({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] }),
  };
  stubFetchByUrl((url, init) => {
    const path = url.pathname;
    const body = respond(path, url, init);
    if (body instanceof Response) return Promise.resolve(body);
    if (body !== undefined) return json(body);
    return json(defaults[path]?.() ?? {});
  });

  eventSources.length = 0;
  installStubEventSource(eventSources);
}

export function installAppTestLifecycle(opened: Root[], reset?: () => void | Promise<void>): void {
  beforeAll(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const root of opened.splice(0)) {
      await act(() => Promise.resolve(root.unmount()));
    }
    await reset?.();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  afterAll(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function composerTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Post text"]');
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

export async function openComposeDialogForTest(open: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    act(open);
    await flush();
    if (document.querySelector('[role="dialog"] textarea[aria-label="Post text"]')) return;
  }
  throw new Error("compose dialog did not open");
}

export async function mountApp(opened: Root[]): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
  return { container, root };
}
