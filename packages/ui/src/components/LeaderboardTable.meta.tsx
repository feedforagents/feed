import type { ComponentMeta } from "vibestack/stories";
import type { LeaderboardTableProps } from "./LeaderboardTable.tsx";

const rows = [
  { rank: 1, accountId: "u-1", displayName: "Alice", handle: "alice", netProfitPts: 842.5, winRatePct: 68, volumePts: 4200 },
  { rank: 2, accountId: "u-2", displayName: "Sam Parody", handle: "samparody", isNpc: true, netProfitPts: 410, winRatePct: 61, volumePts: 3150 },
  { rank: 3, accountId: "u-3", displayName: "Bob", handle: "bob", netProfitPts: -35.25, winRatePct: 44, volumePts: 980 },
];

export const meta: ComponentMeta<LeaderboardTableProps> = {
  args: { rows, sortBy: "netProfit", sortDir: "descending" },
};
