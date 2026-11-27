// spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { afterEach, expect, it, vi } from "vitest";
import { aliceViewer, setupAuthStore } from "./moderation-fixtures.ts";

const OLD_LAST2 = "01";
const NEW_LAST2 = "99";

function viewer(last2: string | null) {
  return { ...aliceViewer, accountId: "acc-1", phoneLast2: last2, phoneVerifiedAt: 1000 };
}

function account(last2: string, accountId = "acc-1") {
  return { ...viewer(last2), accountId, phoneVerifiedAt: 2000 };
}

async function setup(handler: (path: string) => Response) {
  const { core, auth } = await setupAuthStore(handler, viewer(OLD_LAST2));
  return { confirmPhoneChange: auth.confirmPhoneChange, getStoreSnapshot: core.getStoreSnapshot };
}

async function confirmWithMe(me: Response, accountPayload = account(NEW_LAST2)) {
  const { confirmPhoneChange, getStoreSnapshot } = await setup((path) => {
    if (path === "/api/auth/phone/change/confirm") return Response.json({ account: accountPayload });
    if (path === "/api/auth/me") return me;
    return Response.json({});
  });
  const ok = await confirmPhoneChange("+14155550199", "123456");
  return { ok, viewer: getStoreSnapshot().viewer };
}

function meFailure(): Response {
  return Response.json({ code: "internal", message: "boom" }, { status: 500 });
}

function meSuccess(last2: string): Response {
  return Response.json({ authenticated: true, viewer: viewer(last2), acceptedCountries: ["+1"], publicAppUrl: "https://feed.local" });
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('a successful phone change shows the new ending even when the follow-up auth refresh fails (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { ok, viewer: current } = await confirmWithMe(meFailure());

  expect(ok).toBe(true);
  expect(current?.phoneLast2).toBe(NEW_LAST2);
  expect(current?.phoneVerifiedAt).toBe(2000);
});

it('a successful phone change shows the refreshed ending when the follow-up auth refresh succeeds (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { ok, viewer: current } = await confirmWithMe(meSuccess("55"));

  expect(ok).toBe(true);
  expect(current?.phoneLast2).toBe("55");
});

it('a phone change response for another account leaves the viewer unchanged (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  const { ok, viewer: current } = await confirmWithMe(meFailure(), account(NEW_LAST2, "acc-2"));

  expect(ok).toBe(true);
  expect(current?.phoneLast2).toBe(OLD_LAST2);
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
