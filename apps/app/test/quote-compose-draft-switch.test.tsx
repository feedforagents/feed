// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";
import { composerTextarea, flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, makeRawPost, makeViewerSession, mountApp, openComposeDialogForTest, setControlValue } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", composeSession: null });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") return makeAuthMeResponse();
  return undefined;
}

function makePost(id: string, content: string): AppPost {
  const post = decodePost(makeRawPost(1_700_000_000_000, { id, content }), "acct-player-1");
  if (!post) throw new Error(`failed to decode ${id}`);
  return post;
}

async function mountSignedInApp(): Promise<void> {
  installMockNetwork(respond);
  await mountApp(opened);
  await flush();
  setStoreState({ viewer: makeViewerSession({ accountId: "acct-player-1", displayName: "Alice Trader" }) });
  await flush();
}

async function openQuote(post: AppPost): Promise<void> {
  await openComposeDialogForTest(() => { storeActions.openComposeDialog(post); });
}

async function typeDraft(text: string): Promise<void> {
  await setControlValue(composerTextarea(), text);
}

it("clears the quote draft when the compose dialog reopens for a different post", async () => {
  await mountSignedInApp();

  const postA = makePost("post-a", "Post A body");
  const postB = makePost("post-b", "Post B body");

  await openQuote(postA);
  await typeDraft("Draft written for post A");
  expect(composerTextarea().value).toBe("Draft written for post A");

  act(() => { storeActions.closeComposeDialog(); });
  await flush();
  await openQuote(postB);

  expect(document.body.textContent).toContain("Post B body");
  expect(composerTextarea().value).toBe("");
});

it("keeps the quote draft when the compose dialog reopens for the same post", async () => {
  await mountSignedInApp();

  const postA = makePost("post-a", "Post A body");

  await openQuote(postA);
  await typeDraft("Draft written for post A");

  act(() => { storeActions.closeComposeDialog(); });
  await flush();
  await openQuote(postA);

  expect(composerTextarea().value).toBe("Draft written for post A");
});
