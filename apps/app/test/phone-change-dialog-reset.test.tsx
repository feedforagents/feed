// @vitest-environment happy-dom
// spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { findButtonByText, flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, mountApp, setControlValue } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", settingsTab: "profile" });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") return makeAuthMeResponse();
  if (path === "/api/auth/phone/change/start") return {};
  return undefined;
}

function phoneInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#change-phone-input");
}

function codeInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#change-phone-code");
}

async function clickChangePhone(): Promise<void> {
  for (let i = 0; i < 50 && !findButtonByText("Change phone"); i += 1) {
    await flush();
  }
  await act(() => Promise.resolve(findButtonByText("Change phone")?.click()));
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
  await setControlValue(input, "+14155550199");
  await submitPhoneForm();
  expect(codeInput()).not.toBeNull();

  await closeDialog();
  await clickChangePhone();

  expect(codeInput()).toBeNull();
  expect(phoneInput()?.value).toBe("");

  const reopened = phoneInput();
  if (!reopened) throw new Error("phone input missing after reopen");
  await setControlValue(reopened, "+14155550199");
  await closeDialog();
  await clickChangePhone();

  expect(phoneInput()?.value).toBe("");
  await closeDialog();
});
