// spec/app/navigation.md, "Story: Switch between Game mode and Social mode"
import { afterEach, expect, it, vi } from "vitest";

const KEY = "feed:ui-mode";

function stubStorage(value: string | null) {
  const store = new Map<string, string>();
  if (value !== null) store.set(KEY, value);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
  return store;
}

function stubWindow(pathname: string, search: string) {
  const replaceState = vi.fn();
  const pushState = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname, search, origin: "https://feed.local" },
    history: { replaceState, pushState },
    addEventListener: () => {},
  });
  return { replaceState, pushState };
}

function stubEventSource() {
  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

function stubFetch(authMe: unknown) {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "https://feed.local").pathname;
    if (path === "/api/auth/me") return json(authMe);
    if (path === "/api/skills/hosts") return json({ hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);
}

const GAME_VIEWER = {
  authenticated: true,
  viewer: { accountId: "acc-1", handle: "gamer", uiMode: "game" },
  acceptedCountries: ["+1"],
  publicAppUrl: "https://feed.local",
};

const LOGGED_OUT = {
  authenticated: false,
  viewer: null,
  acceptedCountries: ["+1"],
  publicAppUrl: "https://feed.local",
};

async function bootAndSettle(authMe: unknown) {
  stubEventSource();
  stubFetch(authMe);
  const { bootStore } = await import("../src/web/store.ts");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  bootStore();
  await vi.waitFor(() => {
    expect(getStoreSnapshot().authLoaded).toBe(true);
  });
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
  return getStoreSnapshot();
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('logged-out Social mode survives reload (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage("social");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  expect(getStoreSnapshot().localUiMode).toBe("social");
});

it('invalid stored mode falls back to Game (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage("banana");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  expect(getStoreSnapshot().localUiMode).toBe("game");
});

it('Social boot on a shared Markets link starts on Home (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage("social");
  const { replaceState } = stubWindow("/markets", "?ticker=TSLAI");
  const s = await bootAndSettle(LOGGED_OUT);
  expect(s.localUiMode).toBe("social");
  expect(s.route).toBe("Home");
  expect(replaceState).toHaveBeenCalledWith(null, "", "/");
});

it('Signed-in Game boot on a shared Markets link keeps Markets (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage("social");
  const { replaceState } = stubWindow("/markets", "?ticker=TSLAI");
  const s = await bootAndSettle(GAME_VIEWER);
  expect(s.localUiMode).toBe("game");
  expect(s.route).toBe("Markets");
  expect(replaceState).not.toHaveBeenCalled();
});

it('Game boot on a Markets link stays on Markets (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage(null);
  const { replaceState } = stubWindow("/markets", "?ticker=TSLAI");
  const s = await bootAndSettle(LOGGED_OUT);
  expect(s.localUiMode).toBe("game");
  expect(s.route).toBe("Markets");
  expect(replaceState).not.toHaveBeenCalled();
});

it('toggling to Social while logged out persists the choice (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  const store = stubStorage(null);
  stubEventSource();
  stubFetch(LOGGED_OUT);
  const { setPlayMode } = await import("../src/web/store-auth.ts");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  await setPlayMode("social");
  expect(store.get(KEY)).toBe("social");
  expect(getStoreSnapshot().localUiMode).toBe("social");
});
