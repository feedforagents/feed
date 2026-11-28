// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, makeRawPost, mountApp, setControlValue } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", activePostId: null, activeThread: null, feedPosts: [] });
});

const createdAt = Date.now() - 60_000;
const postA = makeRawPost(createdAt, { id: "post-a", content: "Post A market note", replyCount: 1 });
const postB = makeRawPost(createdAt + 1000, {
  id: "post-b",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Builder",
  content: "Bob reply to A",
  replyToPostId: "post-a",
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") return makeAuthMeResponse({ accountId: "alice", displayName: "Alice Player" });
  if (path === "/api/posts/post-a") return { post: postA, replies: [postB] };
  if (path === "/api/posts/post-b") return { post: postB, replies: [] };
  return undefined;
}

function replyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>("#thread-reply-composer");
  if (!el) throw new Error("reply composer not found");
  return el;
}

async function typeReply(container: HTMLElement, text: string): Promise<void> {
  await setControlValue(replyTextarea(container), text);
}

async function openPostA(text: string): Promise<HTMLElement> {
  const { container } = await mountApp(opened);
  await flush();
  await act(async () => {
    await storeActions.navigate("/post/post-a");
  });
  await flush();
  expect(container.textContent).toContain("Post A market note");
  await typeReply(container, text);
  return container;
}

async function openPostAWithDraft(): Promise<HTMLElement> {
  installMockNetwork(respond);
  const container = await openPostA("Draft written for post A");
  expect(replyTextarea(container).value).toBe("Draft written for post A");
  return container;
}

it('Opening another post clears the reply draft written for the previous post (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithDraft();

  await act(async () => {
    await storeActions.navigate("/post/post-b");
  });
  await flush();

  expect(container.textContent).toContain("Bob reply to A");
  expect(replyTextarea(container).value).toBe("");
});

it('Reloading the same post thread keeps the reply draft (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithDraft();

  await act(async () => {
    await storeActions.openThread("post-a", "newest");
  });
  await flush();

  expect(replyTextarea(container).value).toBe("Draft written for post A");
});

it('Completing a queued guest reply after sign-in clears the reply composer (spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"; spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  let signedIn = false;
  let replyPosted = false;
  const createdReply = makeRawPost(createdAt + 2000, {
    id: "reply-queued",
    content: "Queued reply text",
    replyToPostId: "post-a",
  });
  installMockNetwork((path, _url, init) => {
    if (path === "/api/auth/me") {
      return signedIn
        ? makeAuthMeResponse({ accountId: "alice", displayName: "Alice Player" })
        : { authenticated: false, viewer: null };
    }
    if (path === "/api/auth/phone/verify") {
      signedIn = true;
      return { status: "signed_in" };
    }
    if (path === "/api/posts" && init?.method === "POST") {
      replyPosted = true;
      return createdReply;
    }
    if (path === "/api/posts/post-a") {
      return { post: postA, replies: replyPosted ? [postB, createdReply] : [postB] };
    }
    return undefined;
  });
  const container = await openPostA("Queued reply text");

  const form = replyTextarea(container).closest("form");
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit) throw new Error("reply submit button not found");
  act(() => { submit.click(); });
  await flush();
  expect(getStoreSnapshot().pendingAction?.kind).toBe("reply");
  expect(replyTextarea(container).value).toBe("Queued reply text");

  act(() => {
    setStoreState({ pendingPhoneE164: "+15551234567" });
  });
  await act(async () => {
    await storeActions.verifySmsCode("123456");
  });
  await flush();

  expect(replyPosted).toBe(true);
  expect(container.textContent).toContain("Queued reply text");
  expect(replyTextarea(container).value).toBe("");
});
