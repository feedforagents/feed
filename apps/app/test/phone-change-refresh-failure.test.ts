// spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { afterEach, expect, it, vi } from "vitest";

const OLD_LAST2 = "01";
const NEW_LAST2 = "99";

function viewer(last2: string | null) {
  return {
    accountId: "acc-1",
    handle: "alice",
    displayName: "Alice",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: last2,
    phoneVerifiedAt: 1000,
    emailMasked: null,
    emailVerifiedAt: null,
    uiMode: "game" as const,
    balanceCents: 10000,
    startingGrantCents: 10000,
    isAdmin: false,
    isReviewer: false,
    agentGrant: null,
  };
}

function account(last2: string) {
  return {
    accountId: "acc-1",
    handle: "alice",
    displayName: "Alice",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: last2,
    phoneVerifiedAt: 2000,
    emailMasked: null,
    emailVerifiedAt: null,
    uiMode: "game",
    balanceCents: 10000,
    startingGrantCents: 10000,
    isAdmin: false,
    isReviewer: false,
  };
}

function stubFetch(handler: (path: string) => Response) {
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "https://feed.local").pathname;
    return Promise.resolve(handler(path));
  };
  vi.stubGlobal("fetch", fetchMock);
}

async function setup(handler: (path: string) => Response) {
  stubFetch(handler);
  const { setStoreState, getStoreSnapshot } = await import("../src/web/store-core.ts");
  const { confirmPhoneChange } = await import("../src/web/store-auth.ts");
  setStoreState({ viewer: viewer(OLD_LAST2), route: "Settings", settingsTab: "account" });
  return { confirmPhoneChange, getStoreSnapshot };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('a successful phone change shows the new ending even when the follow-up auth refresh fails (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { confirmPhoneChange, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/phone/change/confirm") return Response.json({ account: account(NEW_LAST2) });
    if (path === "/api/auth/me") return Response.json({ code: "internal", message: "boom" }, { status: 500 });
    return Response.json({});
  });

  const ok = await confirmPhoneChange("+14155550199", "123456");

  expect(ok).toBe(true);
  expect(getStoreSnapshot().viewer?.phoneLast2).toBe(NEW_LAST2);
});

it('a successful phone change shows the new ending when the follow-up auth refresh succeeds (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { confirmPhoneChange, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/phone/change/confirm") return Response.json({ account: account(NEW_LAST2) });
    if (path === "/api/auth/me") {
      return Response.json({ authenticated: true, viewer: viewer(NEW_LAST2), acceptedCountries: ["+1"], publicAppUrl: "https://feed.local" });
    }
    return Response.json({});
  });

  const ok = await confirmPhoneChange("+14155550199", "123456");

  expect(ok).toBe(true);
  expect(getStoreSnapshot().viewer?.phoneLast2).toBe(NEW_LAST2);
});

it('a failed phone change keeps the old ending (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { confirmPhoneChange, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/phone/change/confirm") {
      return Response.json({ code: "invalid_code", message: "Incorrect verification code." }, { status: 401 });
    }
    return Response.json({});
  });

  const ok = await confirmPhoneChange("+14155550199", "000000");

  expect(ok).toBe(false);
  expect(getStoreSnapshot().viewer?.phoneLast2).toBe(OLD_LAST2);
});
