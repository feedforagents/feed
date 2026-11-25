// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { App } from "../src/web/App.tsx";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

export const eventSources: EventTarget[] = [];

export type MockResponder = (path: string, url: URL, init?: RequestInit) => unknown;

export function installMockNetwork(respond: MockResponder): void {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    const body = respond(path, url, init);
    if (body !== undefined) return json(body);
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/invites") return json({ invites: [] });
    if (path === "/api/notifications") return json({ items: [], unreadCount: 0 });
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return json({ items: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  eventSources.length = 0;
  class StubEventSource extends EventTarget {
    constructor() {
      super();
      eventSources.push(this);
    }
    close(): void {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

export function installAppTestLifecycle(opened: Root[], reset?: () => void): void {
  beforeAll(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const root of opened.splice(0)) {
      await act(() => Promise.resolve(root.unmount()));
    }
    vi.unstubAllGlobals();
    reset?.();
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
