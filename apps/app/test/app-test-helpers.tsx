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

export function installMockNetwork(respond: MockResponder): void {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  stubFetchByUrl((url, init) => {
    const path = url.pathname;
    const body = respond(path, url, init);
    if (body !== undefined) return json(body);
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ items: [], unreadCount: 0 });
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return json({ items: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
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

export async function mountApp(opened: Root[]): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
  return { container, root };
}
