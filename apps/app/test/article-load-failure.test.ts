// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadArticle } from "../src/web/store-world.ts";
import type { AppArticle } from "../src/web/types.ts";
import { expectFailureNotice, stubFetchUrl } from "./moderation-fixtures.ts";

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

function setArticleStoreState(articles: AppArticle[]): void {
  setStoreState({
    explore: { trending: [], articles, posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    activeArticle: null,
    activeArticleId: null,
    articleLoading: false,
    errorMessage: null,
    toasts: [],
  });
}

function seedCachedArticle(): void {
  setArticleStoreState([cachedArticle]);
}

async function loadArticleFailingWith(status: number, message: string): Promise<void> {
  stubFetchUrl(() => Promise.resolve(Response.json({ message }, { status })));
  await loadArticle("article-a");
  expect(getStoreSnapshot().articleLoading).toBe(false);
}

function freshArticleResponse(id: string, title: string, summary: string, body: string): Promise<Response> {
  return Promise.resolve(Response.json({
    id,
    title,
    summary,
    body,
    authorOrgName: "Feed Wire",
    publishedAt: 1700000000000,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setArticleStoreState([]);
});

it('Opening an article that is not found reports not found (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await loadArticleFailingWith(404, "Article not found");

  expect(getStoreSnapshot().activeArticle).toBeNull();
  expectFailureNotice("Article not found");
});

it('A failed article refresh reports the failure while the cached copy stays readable (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  await loadArticleFailingWith(500, "Article unavailable");

  expect(getStoreSnapshot().activeArticle?.id).toBe("article-a");
  expectFailureNotice("Article unavailable");
});

it('A failed article load with no cached copy reports the failure (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  setStoreState({ errorMessage: null, toasts: [] });
  await loadArticleFailingWith(500, "Article unavailable");

  expect(getStoreSnapshot().activeArticle).toBeNull();
  expectFailureNotice("Article unavailable");
});

it('A successful article load replaces the cached copy with no failure notice (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  seedCachedArticle();
  stubFetchUrl(() => freshArticleResponse("article-a", "Updated headline", "Fresh summary", "Fresh body"));

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
    return freshArticleResponse("article-b", "Second headline", "Second summary", "Second body");
  });

  const pending = loadArticle("article-a");
  await loadArticle("article-b");
  resolveFirst(Response.json({ message: "Article unavailable" }, { status: 500 }));
  await pending;

  expect(getStoreSnapshot().activeArticle?.id).toBe("article-b");
  expect(getStoreSnapshot().errorMessage).toBeNull();
});
