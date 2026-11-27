// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  installAppTestLifecycle,
  installMockNetwork,
  mountApp,
} from "./app-test-helpers.tsx";

const opened: Root[] = [];
installAppTestLifecycle(opened);

it('Opens a Feed Wire article from its individually named control (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const articles = [
    { id: "harbor", title: "Harbor update", summary: "Morning edition", body: "The morning edition.", source: "Fixture newsroom" },
    { id: "gardens", title: "Gardens reopen", summary: "Afternoon edition", body: "The afternoon edition.", source: "Fixture newsroom" },
  ];
  installMockNetwork(path => {
    if (path === "/api/auth/me") return { authenticated: false, viewer: null };
    if (path === "/api/explore") return { articles, trending: [], search: {} };
    if (path === "/api/articles/gardens") return articles[1];
    if (path === "/api/articles/harbor") return articles[0];
    return undefined;
  });

  await mountApp(opened);
  await act(() => userEvent.click(page.getByRole("button", { name: "Explore", exact: true }).first()));
  await act(() => userEvent.click(page.getByRole("tab", { name: "News", exact: true })));

  const first = page.getByRole("button", { name: "Read full article: Harbor update", exact: true });
  const second = page.getByRole("button", { name: "Read full article: Gardens reopen", exact: true });
  await expect.element(first).toBeInTheDocument();
  await expect.element(second).toBeInTheDocument();

  const opener = second.element();
  if (!(opener instanceof HTMLButtonElement)) throw new Error("Expected an article button");
  opener.focus();
  await act(() => userEvent.keyboard("{Enter}"));
  await expect.element(page.getByRole("heading", { name: "Gardens reopen", exact: true, level: 2 })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/article/gardens");
});
