// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleBlock, toggleMute } from "../src/web/store-world.ts";
import { decodeNotifications } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

const aliceViewer = makeViewerSession({ balanceCents: 10_000, startingGrantCents: 10_000 });

function seedNotifications() {
  const payload = decodeNotifications({
    notifications: [
      { id: "n-bob-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
      { id: "n-bob-reply", kind: "reply", actorHandle: "bob", actorName: "Bob", title: "Bob replied", read: true, createdAt: Date.now() - 120_000 },
      { id: "n-carol-like", kind: "like", actorHandle: "carol", actorName: "Carol", title: "Carol liked your post", read: false, createdAt: Date.now() - 30_000 },
      { id: "n-market", kind: "market_resolved", marketId: "seed-market-1", title: "Market resolved", read: false, createdAt: Date.now() - 10_000 },
    ],
    unreadCount: 3,
  });
  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    notifications: payload.items,
    unreadNotifications: payload.unreadCount,
    blockedAccounts: [],
    mutedAccounts: [],
  });
}

const ids = () => getStoreSnapshot().notifications.map((n) => n.item.id);

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    viewer: null,
    route: "Home",
    notifications: [],
    unreadNotifications: 0,
    blockedAccounts: [],
    mutedAccounts: [],
  });
});

it('Blocking an author hides their loaded notifications and drops the bell badge (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  seedNotifications();
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ blocked: true })));

  await toggleBlock("bob", false);

  const s = getStoreSnapshot();
  expect({ ids: ids(), unread: s.unreadNotifications }).toEqual({
    ids: ["n-carol-like", "n-market"],
    unread: 2,
  });
});

it('Muting an author hides their loaded notifications and drops the bell badge (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  seedNotifications();
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ muted: true })));

  await toggleMute("carol", false);

  const s = getStoreSnapshot();
  expect({ ids: ids(), unread: s.unreadNotifications }).toEqual({
    ids: ["n-bob-follow", "n-bob-reply", "n-market"],
    unread: 2,
  });
});

it("A failed block request leaves notifications and the bell badge unchanged", async () => {
  seedNotifications();
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: 500, headers: { "content-type": "application/json" } })),
  );

  await toggleBlock("bob", false);

  const s = getStoreSnapshot();
  expect({ ids: ids(), unread: s.unreadNotifications }).toEqual({
    ids: ["n-bob-follow", "n-bob-reply", "n-carol-like", "n-market"],
    unread: 3,
  });
});

it('Unblocking an author restores their notifications through a refetch (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  const payload = decodeNotifications({
    notifications: [
      { id: "n-carol-like", kind: "like", actorHandle: "carol", actorName: "Carol", title: "Carol liked your post", read: false, createdAt: Date.now() - 30_000 },
    ],
    unreadCount: 1,
  });
  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    notifications: payload.items,
    unreadNotifications: payload.unreadCount,
    blockedAccounts: [{ id: "bob", handle: "bob", displayName: "Bob", bio: "", avatarUrl: null }],
    mutedAccounts: [],
  });
  vi.stubGlobal("fetch", (url: string) => {
    if (url.includes("/api/notifications")) {
      return Promise.resolve(Response.json({
        notifications: [
          { id: "n-bob-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
          { id: "n-carol-like", kind: "like", actorHandle: "carol", actorName: "Carol", title: "Carol liked your post", read: false, createdAt: Date.now() - 30_000 },
        ],
        unreadCount: 2,
      }));
    }
    if (url.includes("/api/feed")) return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    return Promise.resolve(Response.json({ blocked: false }));
  });

  await toggleBlock("bob", true);

  const s = getStoreSnapshot();
  expect({ ids: ids(), unread: s.unreadNotifications }).toEqual({
    ids: ["n-bob-follow", "n-carol-like"],
    unread: 2,
  });
});
