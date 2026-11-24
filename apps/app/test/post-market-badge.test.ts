// spec/social/posts.md, "Story: Project posts for Game and Social presentation modes"
import { expect, it } from "vitest";
import { decodePost } from "../src/web/types.ts";

const idOnlyGamePost = {
  id: "probe-post-id-only",
  authorId: "alice",
  authorKind: "user",
  authorHandle: "alice",
  authorDisplayName: "Alice Player",
  avatarUrl: null,
  isParody: false,
  parodyLabel: "AI parody",
  content: "Will OpenAGI announce pricing before Friday?",
  replyToPostId: null,
  quotePostId: null,
  quotePost: null,
  viaClientName: null,
  marketId: "seed-market-1",
  ticker: null,
  marketBadge: { label: "Will OpenAGI announce GPT-Next compute pricing before Friday close?", oddsPct: null },
  cashtags: [],
  hashtags: [],
  showTradeEmbed: true,
  linkCashtags: false,
  likeCount: 0,
  repostCount: 0,
  replyCount: 0,
  likedByViewer: false,
  repostedByViewer: false,
  createdAt: 1_760_000_000_000,
};

const withTickerGamePost = {
  ...idOnlyGamePost,
  id: "probe-post-with-ticker",
  content: "Shipping thesis on the benchmark callout",
  ticker: "NVDAI",
  marketBadge: { label: "Will OpenAGI announce GPT-Next compute pricing before Friday close?", oddsPct: null },
  cashtags: ["NVDAI"],
  linkCashtags: true,
};

const tickerOnlyGamePost = {
  ...idOnlyGamePost,
  id: "probe-post-ticker-only",
  content: "Shipping thesis on $NVDAI",
  marketId: null,
  ticker: "NVDAI",
  marketBadge: null,
  cashtags: ["NVDAI"],
  linkCashtags: true,
  showTradeEmbed: false,
};

const socialIdOnlyPost = {
  ...idOnlyGamePost,
  id: "probe-post-social",
  marketId: null,
  ticker: null,
  marketBadge: null,
  showTradeEmbed: false,
};

it("shows the market card for a marketId-only post in Game mode", () => {
  const decoded = decodePost(idOnlyGamePost);
  expect(decoded).not.toBeNull();
  expect(decoded?.marketId).toBe("seed-market-1");
  expect(decoded?.card.marketBadge).toEqual({
    marketId: "seed-market-1",
    label: "Will OpenAGI announce GPT-Next compute pricing before Friday close?",
  });
});

it("shows the market card for a marketId+ticker post in Game mode (control)", () => {
  const decoded = decodePost(withTickerGamePost);
  expect(decoded).not.toBeNull();
  expect(decoded?.card.marketBadge).toEqual({
    ticker: "NVDAI",
    label: "Will OpenAGI announce GPT-Next compute pricing before Friday close?",
  });
});

it("shows no market card for a ticker-only post in Game mode", () => {
  const decoded = decodePost(tickerOnlyGamePost);
  expect(decoded).not.toBeNull();
  expect(decoded?.card.marketBadge).toBeUndefined();
});

it("hides the market card for a marketId-only post in Social mode", () => {
  const decoded = decodePost(socialIdOnlyPost);
  expect(decoded).not.toBeNull();
  expect(decoded?.card.marketBadge).toBeUndefined();
});
