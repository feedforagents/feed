// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it } from "vitest";
import { ChatsScreen } from "../src/web/screens/ChatsScreen.tsx";
import { setStoreState } from "../src/web/store-core.ts";
import {
  flush,
  installAppTestLifecycle,
  installMockNetwork,
  makeViewerSession,
} from "./app-test-helpers.tsx";

const opened: Root[] = [];
installAppTestLifecycle(opened);

const viewer = makeViewerSession({ accountId: "viewer-1", handle: "viewer", displayName: "Viewer" });

function ownedGroup(id: string, title: string) {
  return {
    id,
    chatType: "UserGroup" as const,
    title,
    subtitle: "2 members",
    memberCount: 2,
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    peerAvatarUrl: null,
    peerHandle: null,
    members: [
      { memberId: "viewer-1", memberKind: "user" as const, handle: "viewer", displayName: "Viewer", avatarUrl: null, role: "owner" as const },
      { memberId: "bob-1", memberKind: "user" as const, handle: "bob", displayName: "Bob", avatarUrl: null, role: "member" as const },
    ],
    isOwner: true,
    isBlocked: false,
  };
}

function chatButton(container: HTMLElement, title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(title));
  if (!found) throw new Error(`chat button "${title}" not found`);
  return found;
}

function inviteButton(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Invite");
  if (!found) throw new Error("invite button not found");
  return found;
}

function inviteInput(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>("#group-invite-handle");
  if (!found) throw new Error("invite input not found");
  return found;
}

async function setValue(el: HTMLInputElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.bind(el)(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

it('an invite draft belongs to the group it was typed for (spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions")', async () => {
  installMockNetwork(() => undefined);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<ChatsScreen />)));
  await flush();

  act(() => {
    setStoreState({
      viewer,
      chats: [ownedGroup("group-a", "Garden club"), ownedGroup("group-b", "Market watch")],
      selectedChatId: null,
      chatMessages: [],
      alphaInvites: [],
      chatsLoading: false,
    });
  });
  await flush();

  expect(container.textContent).toContain("Garden club");

  await act(() => Promise.resolve(chatButton(container, "Garden club").click()));
  await flush();
  await act(() => Promise.resolve(inviteButton(container).click()));
  await flush();
  await setValue(inviteInput(), "@bob");
  expect(inviteInput().value).toBe("@bob");

  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]');
  if (!close) throw new Error("close button not found");
  await act(() => Promise.resolve(close.click()));
  await flush();

  await act(() => Promise.resolve(chatButton(container, "Market watch").click()));
  await flush();
  await act(() => Promise.resolve(inviteButton(container).click()));
  await flush();
  expect(inviteInput().value).toBe("");
});
