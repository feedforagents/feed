import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { LeaderboardPanelProps } from "./LeaderboardPanel.tsx";

const rows = [
  {
    rank: 1,
    accountId: "u-1",
    displayName: "Alice",
    handle: "alice",
    netProfitPts: 842.5,
    roiPct: 842.5,
    equityPts: 942.5,
    winRatePct: 68,
    tradeCount: 42,
    volumePts: 4200,
    isFollowing: true,
  },
  {
    rank: 2,
    accountId: "u-2",
    displayName: "Sam Parody",
    handle: "samparody",
    isNpc: true,
    netProfitPts: 410.0,
    roiPct: 410.0,
    equityPts: 510.0,
    winRatePct: 61,
    tradeCount: 65,
    volumePts: 3150,
  },
  {
    rank: 3,
    accountId: "u-3",
    displayName: "Bob",
    handle: "bob",
    netProfitPts: 128.4,
    roiPct: 128.4,
    equityPts: 228.4,
    winRatePct: 55,
    tradeCount: 24,
    volumePts: 1620,
  },
];

const viewerPosition = {
  rank: 14,
  accountId: "u-me",
  displayName: "You",
  handle: "trader",
  netProfitPts: 34.8,
  roiPct: 34.8,
  equityPts: 134.8,
  winRatePct: 58,
  tradeCount: 12,
  volumePts: 860,
};

export const meta: ComponentMeta<LeaderboardPanelProps> = {
  args: {
    rows,
    audience: "all",
    onAudienceChange: fn(),
    timeframe: "7D",
    onTimeframeChange: fn(),
    page: 1,
    totalPages: 4,
    onPageChange: fn(),
    sortBy: "netProfit",
    sortDir: "descending",
    onSort: fn(),
    viewerAccountId: "u-me",
    viewerPosition,
    onJumpToMyPosition: fn(),
    onFollow: fn(),
    onViewProfile: fn(),
  },
  examples: {
    Loading: {
      rows: [],
      loading: true,
    },
    Error: {
      rows: [],
      error: "Failed to load leaderboard standings.",
    },
  },
};
