// @vitest-environment happy-dom
// spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { flush, installAppTestLifecycle, installMockNetwork, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", settingsTab: "profile" });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") {
    return {
      authenticated: true,
      viewer: {
        accountId: "acct-player-1",
        handle: "alice",
        displayName: "Alice Trader",
        bio: "",
        avatarUrl: null,
        bannerUrl: null,
        phoneLast2: "01",
        uiMode: "game",
        balanceCents: 10500,
        startingGrantCents: 10000,
        isAdmin: false,
        isReviewer: true,
        agentGrant: null,
      },
      acceptedCountries: ["+1", "+44"],
      publicAppUrl: window.location.origin,
      devSmsCodeEnabled: true,
    };
  }
  if (path === "/api/auth/phone/change/start") return {};
  if (path === "/api/feed" || path === "/api/posts") return { items: [], nextCursor: null };
  if (path === "/api/trending") return { trending: [] };
  if (path === "/api/articles") return { articles: [] };
  if (path === "/api/markets") return { predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } };
  if (path === "/api/world/status") {
    return { currentDay: 3, currentHour: 14, phase: "active", gameRunning: true, lastTickAt: Date.now(), activeMarketsCount: 0, totalPostsCount: 0, activeActorsCount: 5 };
  }
  return undefined;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

function phoneInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#change-phone-input");
}

function codeInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#change-phone-code");
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.bind(input)(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function clickChangePhone(): Promise<void> {
  for (let i = 0; i < 50 && !buttonByText("Change phone"); i += 1) {
    await flush();
  }
  await act(() => Promise.resolve(buttonByText("Change phone")?.click()));
  await flush();
  for (let i = 0; i < 50 && !phoneInput() && !codeInput(); i += 1) {
    await flush();
  }
}

async function openPhoneDialog(): Promise<void> {
  await act(() => Promise.resolve(setStoreState({ route: "Settings", settingsTab: "account" })));
  await flush();
  await clickChangePhone();
}

async function closeDialog(): Promise<void> {
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  await act(() => Promise.resolve(close?.click()));
  await flush();
}

async function submitPhoneForm(): Promise<void> {
  const form = phoneInput()?.closest("form");
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

it('reopening the phone change dialog after closing it starts over at an empty phone step (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
  installMockNetwork(respond);
  await mountApp(opened);
  await flush();

  await openPhoneDialog();
  const input = phoneInput();
  if (!input) throw new Error("phone input missing");
  await typeInto(input, "+14155550199");
  await submitPhoneForm();
  expect(codeInput()).not.toBeNull();

  await closeDialog();
  await clickChangePhone();

  expect(codeInput()).toBeNull();
  expect(phoneInput()?.value).toBe("");

  const reopened = phoneInput();
  if (!reopened) throw new Error("phone input missing after reopen");
  await typeInto(reopened, "+14155550199");
  await closeDialog();
  await clickChangePhone();

  expect(phoneInput()?.value).toBe("");
  await closeDialog();
});
