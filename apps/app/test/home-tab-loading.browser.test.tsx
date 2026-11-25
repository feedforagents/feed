// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";

const latestPost = { id: "latest-post", content: "Latest timeline post" };
const latestMorePost = { id: "latest-more-post", content: "Latest timeline continued post" };
const topPost = { id: "top-post", content: "Top timeline post" };

async function releaseAndWait(release: () => void): Promise<void> {
  await act(async () => {
    release();
    await Promise.resolve();
  });
}

async function gatedResponse(
  started: Array<PromiseWithResolvers<void>>,
  releases: Array<PromiseWithResolvers<void>>,
  makeResponse: (index: number) => Response,
): Promise<Response> {
  const index = started.length;
  const gate = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  started.push(gate);
  releases.push(release);
  gate.resolve();
  await release.promise;
  return makeResponse(index);
}

it('Keeps the displayed timeline aligned with the active Home tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  class IdleEventSource extends EventTarget {
    close() {}
  }
  const loadMoreStarted = Promise.withResolvers<void>();
  const releaseLoadMore = Promise.withResolvers<void>();
  const topStarted: Array<PromiseWithResolvers<void>> = [];
  const topReleases: Array<PromiseWithResolvers<void>> = [];
  vi.stubGlobal("EventSource", IdleEventSource);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.pathname === "/api/auth/me") return Response.json({ authenticated: true, viewer: { accountId: "fixture-reader", handle: "fixture-reader" } });
    if (url.pathname === "/api/skills/hosts") return Response.json({ hosts: [] });
    if (url.pathname === "/api/feed" && url.searchParams.get("tab") === "latest" && url.searchParams.get("cursor") === "latest-cursor-1") {
      loadMoreStarted.resolve();
      await releaseLoadMore.promise;
      return Response.json({ items: [latestMorePost], nextCursor: null });
    }
    if (url.pathname === "/api/feed" && url.searchParams.get("tab") === "latest") {
      return Response.json({ items: [latestPost], nextCursor: "latest-cursor-1" });
    }
    if (url.pathname === "/api/feed" && url.searchParams.get("tab") === "top") {
      return gatedResponse(topStarted, topReleases, () => Response.json({ items: [topPost], nextCursor: null }));
    }
    return Response.json({}, { status: 404 });
  });
  const oldPath = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", "/");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(() => Promise.resolve(root.render(<App />)));
    const latest = page.getByText("Latest timeline post", { exact: true });
    const latestMore = page.getByText("Latest timeline continued post", { exact: true });
    const top = page.getByText("Top timeline post", { exact: true });
    async function expectTimeline(shown: typeof latest, hidden: typeof latest): Promise<void> {
      await expect.element(shown).toBeInTheDocument();
      await expect.element(hidden).not.toBeInTheDocument();
    }
    await expect.element(latest).toBeInTheDocument();

    await act(() => userEvent.click(page.getByRole("button", { name: "Load more", exact: true })));
    await loadMoreStarted.promise;
    await act(() => userEvent.click(page.getByRole("tab", { name: "For You", exact: true })));
    await topStarted[0].promise;
    await releaseAndWait(() => releaseLoadMore.resolve());
    await expect.element(latestMore).not.toBeInTheDocument();
    await expect.element(latest).not.toBeInTheDocument();

    await releaseAndWait(() => topReleases[0].resolve());
    await expectTimeline(top, latest);

    await act(() => userEvent.click(page.getByRole("tab", { name: "Latest", exact: true })));
    await expectTimeline(latest, top);

    await act(() => userEvent.click(page.getByRole("tab", { name: "For You", exact: true })));
    await topStarted[1].promise;
    await expect.element(latest).not.toBeInTheDocument();

    await act(() => userEvent.click(page.getByRole("tab", { name: "Latest", exact: true })));
    await expect.element(latest).toBeInTheDocument();
    await releaseAndWait(() => topReleases[1].resolve());
    await expectTimeline(latest, top);
  } finally {
    releaseLoadMore.resolve();
    for (const release of topReleases) release.resolve();
    await act(() => Promise.resolve(root.unmount()));
    container.remove();
    window.history.replaceState(null, "", oldPath);
    vi.unstubAllGlobals();
  }
});
