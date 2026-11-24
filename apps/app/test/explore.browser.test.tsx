// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ExploreScreen } from "../src/web/screens/ExploreScreen.tsx";
import { storeActions } from "../src/web/store.ts";

const trending = [{ tag: "#first" }, { tag: "#second" }];
const initial = { trending, articles: [], search: { accounts: [] } };
const resultFor = (handle: string) => ({
  ...initial,
  search: { accounts: [{ handle, displayName: handle }] },
});

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

it.each(["before", "after"] as const)(
  'Explore keeps the latest search when the previous response arrives %s it (spec/app/navigation.md, "Story: Browse public world content without a login wall")',
  async (order) => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", (input: string) => {
      const url = new URL(input, location.origin);
      if (url.pathname === "/api/auth/me") return Promise.resolve(Response.json({ authenticated: false, viewer: null }));
      if (url.pathname === "/api/skills/hosts") return Promise.resolve(Response.json({ hosts: [] }));
      if (url.pathname === "/api/feed") return Promise.resolve(Response.json([]));
      if (url.pathname !== "/api/explore") throw new Error(`Unexpected request: ${input}`);
      switch (url.searchParams.get("q")) {
        case "#first": return first.promise;
        case "#second": return second.promise;
        default: return Promise.resolve(Response.json(initial));
      }
    });

    await storeActions.loadExplore("");
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    mounted = { root, container };
    await act(async () => { await Promise.resolve(); root.render(<ExploreScreen mode="SocialMode" />); });

    const search = page.getByRole("button", { name: "Search", exact: true });
    const older = page.getByText("@older_result", { exact: true });
    const latest = page.getByText("@latest_result", { exact: true });
    await act(() => userEvent.click(page.getByRole("button", { name: "#first", exact: true })));
    await act(() => userEvent.click(page.getByRole("button", { name: "#second", exact: true })));
    await expect.element(search).toBeDisabled();

    const complete = async (pending: typeof first, handle: string) => {
      const response = Response.json(resultFor(handle));
      const consumed = Promise.withResolvers<void>();
      const read = response.text.bind(response);
      vi.spyOn(response, "text").mockImplementation(async () => {
        try {
          return await read();
        } finally {
          consumed.resolve();
        }
      });
      await act(async () => {
        pending.resolve(response);
        await consumed.promise;
      });
    };

    if (order === "before") {
      await complete(first, "older_result");
      await expect.element(search).toBeDisabled();
      await expect.element(older).not.toBeInTheDocument();
    }
    await complete(second, "latest_result");
    await expect.element(latest).toBeInTheDocument();
    await expect.element(search).toBeEnabled();
    if (order === "after") await complete(first, "older_result");
    await expect.element(latest).toBeInTheDocument();
    await expect.element(older).not.toBeInTheDocument();
  },
);
