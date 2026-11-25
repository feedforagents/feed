// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ExploreScreen } from "../src/web/screens/ExploreScreen.tsx";
import { storeActions } from "../src/web/store.ts";

const trending = [{ id: "trending-launch", title: "#launch", kind: "hashtag", financial: false }];

let mounted: { root: Root; container: HTMLElement } | undefined;

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    mounted = undefined;
    await act(async () => { await Promise.resolve(); root.unmount(); });
    container.remove();
  }
  vi.unstubAllGlobals();
});

it('Explore search box follows the active search when it changes outside the box (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", undefined);
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, location.origin);
    if (url.pathname === "/api/auth/me") return Promise.resolve(Response.json({ authenticated: false, viewer: null }));
    if (url.pathname === "/api/skills/hosts") return Promise.resolve(Response.json({ hosts: [] }));
    if (url.pathname === "/api/feed") return Promise.resolve(Response.json([]));
    if (url.pathname !== "/api/explore") throw new Error(`Unexpected request: ${input}`);
    return Promise.resolve(Response.json({ trending, articles: [], search: { posts: [], accounts: [], actors: [], organizations: [], tags: [] } }));
  });

  await storeActions.loadExplore("");

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => { await Promise.resolve(); root.render(<ExploreScreen mode="GameMode" />); });

  const searchBox = page.getByLabel("Search Feed");
  await expect.element(searchBox).toBeInTheDocument();
  await act(() => userEvent.fill(searchBox, "cats"));
  await expect.element(searchBox).toHaveValue("cats");

  await act(async () => { await storeActions.loadExplore("#launch"); });

  await expect.element(searchBox).toHaveValue("#launch");
});
