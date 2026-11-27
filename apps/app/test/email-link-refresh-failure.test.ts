// spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown"
import { afterEach, expect, it, vi } from "vitest";
import { aliceViewer, setupAuthStore } from "./moderation-fixtures.ts";

const OLD_MASKED = "a***@example.com";
const NEW_MASKED = "b***@example.com";

function viewer(emailMasked: string | null, emailVerifiedAt: number | null) {
  return { ...aliceViewer, accountId: "acc-1", phoneLast2: "01", phoneVerifiedAt: 1000, emailMasked, emailVerifiedAt };
}

function account(emailMasked: string, emailVerifiedAt: number, accountId = "acc-1") {
  return { ...viewer(emailMasked, emailVerifiedAt), accountId };
}

async function setup(handler: (path: string) => Response) {
  const { core, auth } = await setupAuthStore(handler, viewer(OLD_MASKED, 1000));
  return { verifyEmailMagicLink: auth.verifyEmailMagicLink, getStoreSnapshot: core.getStoreSnapshot };
}

async function verifyWithMe(me: Response, accountPayload = account(NEW_MASKED, 2000)) {
  const { verifyEmailMagicLink, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/email/verify") {
      return Response.json({ status: "email_linked", emailMasked: NEW_MASKED, account: accountPayload, redirectTo: "/settings?tab=account" });
    }
    if (path === "/api/auth/me") return me;
    return Response.json({});
  });
  await verifyEmailMagicLink("token-1");
  return getStoreSnapshot();
}

function meFailure(): Response {
  return Response.json({ code: "internal", message: "boom" }, { status: 500 });
}

function meSuccess(emailMasked: string): Response {
  return Response.json({ authenticated: true, viewer: viewer(emailMasked, 3000), acceptedCountries: ["+1"], publicAppUrl: "https://feed.local" });
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('a completed email link shows the new masked address even when the follow-up auth refresh fails (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const s = await verifyWithMe(meFailure());

  expect(s.emailVerifyStatus).toBe("linked");
  expect(s.viewer?.emailMasked).toBe(NEW_MASKED);
  expect(s.viewer?.emailVerifiedAt).toBe(2000);
});

it('a completed email link shows the refreshed masked address when the follow-up auth refresh succeeds (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const s = await verifyWithMe(meSuccess("c***@example.com"));

  expect(s.emailVerifyStatus).toBe("linked");
  expect(s.viewer?.emailMasked).toBe("c***@example.com");
});

it('an email link response for another account leaves the viewer unchanged (spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown")', async () => {
  const s = await verifyWithMe(meFailure(), account(NEW_MASKED, 2000, "acc-2"));

  expect(s.emailVerifyStatus).toBe("linked");
  expect(s.viewer?.emailMasked).toBe(OLD_MASKED);
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
