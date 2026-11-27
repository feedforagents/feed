// spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown"
import { afterEach, expect, it, vi } from "vitest";

const OLD_MASKED = "a***@example.com";
const NEW_MASKED = "b***@example.com";

function viewer(emailMasked: string | null, emailVerifiedAt: number | null) {
  return {
    accountId: "acc-1",
    handle: "alice",
    displayName: "Alice",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: "01",
    phoneVerifiedAt: 1000,
    emailMasked,
    emailVerifiedAt,
    uiMode: "game" as const,
    balanceCents: 10000,
    startingGrantCents: 10000,
    isAdmin: false,
    isReviewer: false,
    agentGrant: null,
  };
}

function account(emailMasked: string, emailVerifiedAt: number) {
  return {
    accountId: "acc-1",
    handle: "alice",
    displayName: "Alice",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: "01",
    phoneVerifiedAt: 1000,
    emailMasked,
    emailVerifiedAt,
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
  const { verifyEmailMagicLink } = await import("../src/web/store-auth.ts");
  setStoreState({ viewer: viewer(OLD_MASKED, 1000), route: "Settings", settingsTab: "account" });
  return { verifyEmailMagicLink, getStoreSnapshot };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('a completed email link shows the new masked address even when the follow-up auth refresh fails (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const { verifyEmailMagicLink, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/email/verify") {
      return Response.json({ status: "email_linked", emailMasked: NEW_MASKED, account: account(NEW_MASKED, 2000), redirectTo: "/settings?tab=account" });
    }
    if (path === "/api/auth/me") return Response.json({ code: "internal", message: "boom" }, { status: 500 });
    return Response.json({});
  });

  await verifyEmailMagicLink("token-1");

  expect(getStoreSnapshot().emailVerifyStatus).toBe("linked");
  expect(getStoreSnapshot().viewer?.emailMasked).toBe(NEW_MASKED);
  expect(getStoreSnapshot().viewer?.emailVerifiedAt).toBe(2000);
});

it('a completed email link shows the new masked address when the follow-up auth refresh succeeds (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const { verifyEmailMagicLink, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/email/verify") {
      return Response.json({ status: "email_linked", emailMasked: NEW_MASKED, account: account(NEW_MASKED, 2000), redirectTo: "/settings?tab=account" });
    }
    if (path === "/api/auth/me") {
      return Response.json({ authenticated: true, viewer: viewer(NEW_MASKED, 2000), acceptedCountries: ["+1"], publicAppUrl: "https://feed.local" });
    }
    return Response.json({});
  });

  await verifyEmailMagicLink("token-1");

  expect(getStoreSnapshot().emailVerifyStatus).toBe("linked");
  expect(getStoreSnapshot().viewer?.emailMasked).toBe(NEW_MASKED);
});

it('a failed email link keeps the old masked address (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const { verifyEmailMagicLink, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/email/verify") {
      return Response.json({ code: "invalid_magic_link", message: "This sign-in link has expired." }, { status: 401 });
    }
    return Response.json({});
  });

  await verifyEmailMagicLink("token-1");

  expect(getStoreSnapshot().emailVerifyStatus).toBe("error");
  expect(getStoreSnapshot().viewer?.emailMasked).toBe(OLD_MASKED);
});
