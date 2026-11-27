// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../src/main.css";
import { installAppTestLifecycle, installMockNetwork, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];
installAppTestLifecycle(opened);

it('Keeps all Explore tabs inside a narrow viewport (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork(path => {
    if (path === "/api/auth/me") return { authenticated: false, viewer: null };
    if (path === "/api/explore") return { articles: [], trending: [], search: {} };
    return undefined;
  });

  await page.viewport(320, 720);
  await mountApp(opened);
  await act(() => userEvent.click(page.getByRole("button", { name: "Explore", exact: true }).first()));
  const row = page.getByRole("main").getByRole("tablist");
  await expect.element(row.getByRole("tab", { name: "Trending", selected: true })).toBeInTheDocument();
  const tabs = row.getByRole("tab").elements();
  expect(tabs).toHaveLength(5);
  expect(window.innerWidth).toBe(320);
  expect(Math.round(Math.max(...tabs.map(tab => tab.getBoundingClientRect().right)))).toBeLessThanOrEqual(320);
});
