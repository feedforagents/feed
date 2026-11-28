// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadArticle } from "../src/web/store-world.ts";
import type { AppArticle } from "../src/web/types.ts";
import { stubFetchUrl } from "./moderation-fixtures.ts";

const cachedArticle: AppArticle = {
  id: "article-a",
  title: "Cached headline",
  summary: "Cached summary",
  source: "Feed Wire",
  timestamp: "1h",
  authorOrgId: null,
  body: "Cached body",
  relatedMarketId: null,
  isResolutionProof: false,
  publishedAtMs: 1700000000000,
};

function seedCachedArticle() {
  setStoreState({
    explore: { trending: [], articles: [cachedArticle], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    activeArticle: null,
    activeArticleId: null,
    articleLoading: false,
    errorMessage: null,
    toasts: [],
  });
}

function expectFailureNotice(message: string): void {
  const current = getStoreSnapshot();
  expect(current.errorMessage).toBe(message);
  expect(current.toasts.some((t) => t.tone === "destructive" && t.message === message)).toBe(true);
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    activeArticle: null,
    activeArticleId: null,
    articleLoading: false,
    errorMessage: null,
    toasts: [],
  });
});

it('Opening a removed article reports not found instead of showing the cached copy (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  stubFetchUrl(() => Promise.resolve(Response.json({ message: "Article not found" }, { status: 404 })));

  await loadArticle("article-a");

  expect(getStoreSnapshot().articleLoading).toBe(false);
  expect(getStoreSnapshot().activeArticle).toBeNull();
  expectFailureNotice("Article not found");
});

it('A failed article refresh reports the failure while the cached copy stays readable (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  stubFetchUrl(() => Promise.resolve(Response.json({ message: "Article unavailable" }, { status: 500 })));

  await loadArticle("article-a");

  expect(getStoreSnapshot().articleLoading).toBe(false);
  expect(getStoreSnapshot().activeArticle?.id).toBe("article-a");
  expectFailureNotice("Article unavailable");
});

it('A failed article load with no cached copy reports the failure (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  setStoreState({ errorMessage: null, toasts: [] });
  stubFetchUrl(() => Promise.resolve(Response.json({ message: "Article unavailable" }, { status: 500 })));

  await loadArticle("article-a");

  expect(getStoreSnapshot().articleLoading).toBe(false);
  expect(getStoreSnapshot().activeArticle).toBeNull();
  expectFailureNotice("Article unavailable");
});

it('A successful article load replaces the cached copy with no failure notice (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  stubFetchUrl(() => Promise.resolve(Response.json({
    id: "article-a",
    title: "Updated headline",
    summary: "Fresh summary",
    body: "Fresh body",
    authorOrgName: "Feed Wire",
    publishedAt: 1700000000000,
  })));

  await loadArticle("article-a");

  expect(getStoreSnapshot().activeArticle?.title).toBe("Updated headline");
  expect(getStoreSnapshot().activeArticle?.body).toBe("Fresh body");
  expect(getStoreSnapshot().errorMessage).toBeNull();
});

it('A superseded article load that fails stays silent (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  let resolveFirst: (res: Response) => void = () => undefined;
  let firstCall = true;
  stubFetchUrl(() => {
    if (firstCall) {
      firstCall = false;
      return new Promise<Response>((settle) => { resolveFirst = settle; });
    }
    return Promise.resolve(Response.json({
      id: "article-b",
      title: "Second headline",
      summary: "Second summary",
      body: "Second body",
      authorOrgName: "Feed Wire",
      publishedAt: 1700000000000,
    }));
  });

  const pending = loadArticle("article-a");
  await loadArticle("article-b");
  resolveFirst(Response.json({ message: "Article unavailable" }, { status: 500 }));
  await pending;

  expect(getStoreSnapshot().activeArticle?.id).toBe("article-b");
  expect(getStoreSnapshot().errorMessage).toBeNull();
});
