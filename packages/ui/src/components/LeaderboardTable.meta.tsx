import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { LeaderboardTableProps } from "./LeaderboardTable.tsx";

const onScopeChange = fn();
const onMetricChange = fn();
const onPageChange = fn();
const onJumpToCurrentUser = fn();

const rows = [
  { rank: 1, accountId: "u-1", displayName: "Alice", handle: "alice", netProfitPts: 84.5, returnPct: 84.5, winRatePct: 68, volumePts: 420 },
  { rank: 2, accountId: "u-2", displayName: "Sam Parody", handle: "samparody", isNpc: true, netProfitPts: 41, returnPct: 41, winRatePct: 61, volumePts: 315 },
  { rank: 3, accountId: "u-3", displayName: "Bob", handle: "bob", netProfitPts: -12.5, returnPct: -12.5, winRatePct: 44, volumePts: 98 },
];

export const meta: ComponentMeta<LeaderboardTableProps> = {
  args: { rows, sortBy: "netProfit", sortDir: "descending", currentUserId: "u-1" },
  examples: {
    WithBoardsAndPagination: {
      rows,
      scope: "players",
      onScopeChange,
      metric: "net_profit",
      onMetricChange,
      page: 1,
      totalPages: 4,
      totalCount: 92,
      onPageChange,
      currentUserId: "u-42",
      currentUserRow: {
        rank: 42,
        accountId: "u-42",
        displayName: "Dana",
        handle: "dana",
        netProfitPts: 12.5,
        returnPct: 12.5,
        winRatePct: 55,
        volumePts: 180,
      },
      onJumpToCurrentUser,
    },
  },
  play: {
    WithBoardsAndPagination: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onScopeChange.mockClear();
      onMetricChange.mockClear();
      onJumpToCurrentUser.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText("+84.5%")).toBeVisible();
      await expect(canvas.getByText("-12.5%")).toBeVisible();
      await userEvent.click(canvas.getByRole("radio", { name: "Characters" }));
      await expect(onScopeChange).toHaveBeenCalledWith("characters");
      await userEvent.click(canvas.getByRole("button", { name: "Jump to my rank" }));
      await expect(onJumpToCurrentUser).toHaveBeenCalled();
    },
  },
};
