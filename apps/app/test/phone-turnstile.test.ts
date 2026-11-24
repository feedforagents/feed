// spec/auth/phone.md, "Only allowed countries, non-VoIP lines, Turnstile-verified requests, and rate-limited numbers receive a 6-digit autofill code"
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { requestSmsCode, resendSmsCode } from "../src/web/store-auth.ts";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

let captured: Array<CapturedRequest> = [];

function installPhoneStartStub() {
  captured = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    captured.push({ url, body });
    return Promise.resolve(Response.json({ challengeId: "challenge-test", last2: "99", expiresAt: Date.now() + 600_000, resendAvailableAt: Date.now() + 30_000 }));
  };
}

beforeEach(() => {
  installPhoneStartStub();
  setStoreState({ joinPhoneStep: "entry", joinError: null, joinLoading: false, pendingPhoneE164: "" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Phone SMS sends its Turnstile token to the SMS gate (spec/auth/phone.md, "Only allowed countries, non-VoIP lines, Turnstile-verified requests, and rate-limited numbers receive a 6-digit autofill code")', () => {
  it("requestSmsCode passes the Turnstile token from the phone login flow to /api/auth/phone/start", async () => {
    await requestSmsCode("US", "+14155550199", "turnstile-token-1");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("/api/auth/phone/start");
    expect(captured[0]?.body).toMatchObject({ phoneE164: "+14155550199", turnstileToken: "turnstile-token-1" });
    expect(getStoreSnapshot().joinPhoneStep).toBe("verify");
  });

  it("resendSmsCode passes a fresh Turnstile token instead of reusing the first request", async () => {
    await requestSmsCode("US", "+14155550199", "turnstile-token-1");
    captured = [];
    await resendSmsCode("turnstile-token-2");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({ phoneE164: "+14155550199", turnstileToken: "turnstile-token-2" });
    expect(getStoreSnapshot().joinPhoneStep).toBe("verify");
  });
});
