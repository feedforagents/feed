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
