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
  vi.stubGlobal("window", {
    location: { pathname, search, origin: "https://feed.local" },
    history: { replaceState: vi.fn() },
    addEventListener: () => {},
  });
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
  stubWindow("/markets", "?ticker=TSLAI");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  expect(getStoreSnapshot().localUiMode).toBe("social");
  expect(getStoreSnapshot().route).toBe("Home");
});

it('Game boot on a Markets link stays on Markets (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  stubStorage(null);
  stubWindow("/markets", "?ticker=TSLAI");
  const { getStoreSnapshot } = await import("../src/web/store-core.ts");
  expect(getStoreSnapshot().localUiMode).toBe("game");
  expect(getStoreSnapshot().route).toBe("Markets");
});
