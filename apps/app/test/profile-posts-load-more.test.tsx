// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile } from "../src/web/store-world.ts";
import { flush, installAppTestLifecycle, installMockNetwork, makeRawPost, makeRawProfileBundle, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", profileBundle: null, profileHandle: null, profileLoadingMore: false });
});

const createdAt = Date.now() - 60_000;

function replyPost(id: string, content: string): Record<string, unknown> {
  return makeRawPost(createdAt, {
    id,
    authorId: "carol",
    authorHandle: "carol",
    authorDisplayName: "Carol Analyst",
    content,
    replyToPostId: "parent-post",
    repostedByHandle: "bob",
    repostedByName: "Bob Builder",
  });
}

function respond(path: string, url: URL): unknown {
  if (path === "/api/auth/me") return { authenticated: false };
  if (path === "/api/users/bob") {
    if (url.searchParams.get("cursor")) {
      return {
        ...makeRawProfileBundle({
          handle: "bob",
          displayName: "Bob Builder",
          createdAt,
          postsCount: 3,
          posts: [
            makeRawPost(createdAt, {
              id: "bob-older",
              authorId: "bob",
              authorHandle: "bob",
              authorDisplayName: "Bob Builder",
              content: "Bob older top-level post",
            }),
          ],
        }),
        nextCursor: null,
      };
    }
    return {
      ...makeRawProfileBundle({
        handle: "bob",
        displayName: "Bob Builder",
        createdAt,
        postsCount: 3,
        posts: [replyPost("reply-1", "Carol reply one"), replyPost("reply-2", "Carol reply two")],
      }),
      nextCursor: "bob-cursor-1",
    };
  }
  if (path === "/api/feed" || path === "/api/posts") return { items: [], nextCursor: null };
  if (path === "/api/trending") return { trending: [] };
  if (path === "/api/articles") return { articles: [] };
  if (path === "/api/markets") return { predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } };
  if (path === "/api/world/status") {
    return {
      currentDay: 3,
      currentHour: 14,
      phase: "active",
      gameRunning: true,
      lastTickAt: Date.now(),
      activeMarketsCount: 0,
      totalPostsCount: 0,
      activeActorsCount: 5,
    };
  }
  return undefined;
}

function loadMoreButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.trim() === "Load more",
  );
}

it('Profile Posts Load more stays reachable when the first page holds only reposted replies (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();

  await act(() => loadProfile("bob"));
  await act(() => Promise.resolve(setStoreState({ route: "Profile", profileHandle: "bob" })));
  await flush();

  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-1");
  expect(container.textContent).not.toContain("No posts yet");

  const button = loadMoreButton(container);
  expect(button).toBeDefined();

  await act(() => Promise.resolve(button?.click()));
  await flush();

  expect(container.textContent).toContain("Bob older top-level post");
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBeNull();
  expect(loadMoreButton(container)).toBeUndefined();
});
