import type { ComponentProps } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";

export type TableProps = ComponentProps<"table"> & {
  /** Accessible name for the scrollable table region. */
  label: string;
};
export type TableSectionProps = ComponentProps<"tbody">;
export type TableRowProps = ComponentProps<"tr">;
export type TableHeadProps = ComponentProps<"th"> & {
  /** Sort direction communicated through `aria-sort`. */
  sort?: "ascending" | "descending" | "none";
  /** Turns the column header into a sortable button. */
  onSort?: () => void;
};
export type TableCellProps = ComponentProps<"td">;
export type TableCaptionProps = ComponentProps<"caption"> & {
  /** Hides the caption visually while keeping it accessible to screen readers. */
  visuallyHidden?: boolean;
};

const arrows = { ascending: ArrowUp, descending: ArrowDown, none: ArrowUpDown };

/** Data table wrapped in a keyboard-scrollable landmark region. */
export function Table({ label, className, ...props }: TableProps) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={cn(focusRing, "w-full overflow-x-auto rounded-md")}>
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

/** Table header group. */
export function TableHeader({ className, ...props }: TableSectionProps) {
  return <thead className={cn("border-b border-border", className)} {...props} />;
}

/** Table body rows container. */
export function TableBody({ className, ...props }: TableSectionProps) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

/** Table row. */
export function TableRow({ className, ...props }: TableRowProps) {
  return <tr className={cn("border-b border-border transition-colors hover:bg-muted/50", className)} {...props} />;
}

/** Table column header with optional sorting button. */
export function TableHead({ sort, onSort, scope = "col", className, children, ...props }: TableHeadProps) {
  const Arrow = arrows[sort ?? "none"];
  return (
    <th scope={scope} aria-sort={sort ?? (onSort && "none")} className={cn("h-10 px-3 text-left font-medium whitespace-nowrap text-muted-foreground", className)} {...props}>
      {onSort ? (
        <button type="button" onClick={onSort} className={cn(focusRing, "inline-flex items-center gap-1 rounded-sm py-1 hover:text-foreground")}>
          {children}
          <Arrow aria-hidden className="size-3.5" />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/** Table data cell. */
export function TableCell({ className, ...props }: TableCellProps) {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

/** Accessible caption describing the table. */
export function TableCaption({ visuallyHidden = false, className, ...props }: TableCaptionProps) {
  return <caption className={cn(visuallyHidden ? "sr-only" : "mt-3 text-sm text-muted-foreground", className)} {...props} />;
}
