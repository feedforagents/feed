import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { TableBody, TableCaption, TableCell, TableHead, TableHeader, type TableProps, TableRow } from "./Table.tsx";

const rows = [
  ["@alice", "+420 pts", "68%"],
  ["@bob", "+115 pts", "54%"],
];
const onSort = fn();

const buildTable = (sorted: boolean) => (
  <>
    <TableCaption visuallyHidden>Top traders</TableCaption>
    <TableHeader>
      <TableRow>
        <TableHead>Trader</TableHead>
        <TableHead {...(sorted && { sort: "descending", onSort })} className="text-right">Net Profit</TableHead>
        <TableHead className="text-right">Win Rate</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map(([trader, profit, win]) => (
        <TableRow key={trader}>
          <TableCell>{trader}</TableCell>
          <TableCell className="text-right font-mono text-ok tabular-nums">{profit}</TableCell>
          <TableCell className="text-right font-mono tabular-nums">{win}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </>
);

export const meta: ComponentMeta<TableProps> = {
  args: { label: "Top traders", children: buildTable(false) },
  examples: { Sorted: { children: buildTable(true) } },
  play: {
    Sorted: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSort.mockClear();
      const canvas = within(canvasElement);
      const headers = canvas.getAllByRole("columnheader");
      await expect(headers.map((h) => h.getAttribute("aria-sort"))).toEqual([null, "descending", null]);
      await userEvent.click(canvas.getByRole("button", { name: /Net Profit/ }));
      await expect(onSort).toHaveBeenCalledOnce();
    },
  },
};
