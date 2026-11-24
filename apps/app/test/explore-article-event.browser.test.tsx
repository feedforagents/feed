// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

const sources: EventTarget[] = [];
let articleTwoPublished = false;

function article(id: string, title: string) {
  return {
    id,
    title,
    summary: `${title} summary`,
    body: `${title} body`,
    source: "Feed Wire",
    publishedAt: Date.now(),
  };
}

function installMockNetwork() {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: false,
        viewer: null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/feed") return json([]);
    if (path === "/api/markets") return json({ predictions: [], perps: [], positions: [], economy: null });
    if (path === "/api/explore") {
      const articles = articleTwoPublished ? [article("wire-1", "Wire Dispatch One"), article("wire-2", "Wire Dispatch Two")] : [article("wire-1", "Wire Dispatch One")];
      return json({ trending: [], articles, search: { posts: [], accounts: [], markets: [] } });
    }
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    constructor() {
      super();
      sources.push(this);
    }

    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  sources.splice(0);
  articleTwoPublished = false;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('Explore refreshes when a new article is published (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await act(() => storeActions.navigate("/explore"));
  await expect.element(page.getByText("Wire Dispatch One")).toBeInTheDocument();
  expect(document.body.textContent ?? "").not.toContain("Wire Dispatch Two");

  articleTwoPublished = true;
  await act(() => Promise.resolve(sources[0]?.dispatchEvent(new Event("article.published"))));
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").toContain("Wire Dispatch Two");
    },
    { timeout: 5000 },
  );
});
