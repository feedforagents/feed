import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn.ts";
import { splitTextSegments } from "../lib/hosts.ts";
import { CopyButton, type CopyButtonProps } from "./CopyButton.tsx";

export type CommandBlockProps = Omit<ComponentProps<"div">, "onCopy" | "children"> & {
  /** Exact command or prompt string to render and copy. */
  command: string;
  /** Accessible label for the command region. */
  label?: string;
  /** Accessible label for the copy button. */
  copyLabel?: string;
  /** Clipboard handler forwarded to `CopyButton`. */
  onCopy?: CopyButtonProps["onCopy"];
  /** Optional links rendered beside the copy button. */
  links?: ReactNode;
  /** `block` keeps commands horizontally scrollable; `inline` wraps prompts beside a primary copy CTA. */
  layout?: "block" | "inline";
  /** Visible text per copy state forwarded to `CopyButton`. */
  copyLabels?: CopyButtonProps["labels"];
};

const breaks = /(https?:\/\/[^/\s]+\/)/u;

/** Displays a copyable shell command or agent prompt with clean break points and copy feedback. */
export function CommandBlock({
  command,
  label = "Command",
  copyLabel = "Copy command",
  onCopy,
  links,
  layout = "block",
  copyLabels,
  className,
  ...props
}: CommandBlockProps) {
  if (layout === "inline") {
    return (
      <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-border bg-card p-4", className)} {...props}>
        <code role="group" aria-label={label} className="min-w-0 font-mono text-sm font-medium break-normal whitespace-normal text-foreground wrap-anywhere">
          {splitTextSegments(command, breaks).map((segment) => (
            <span key={segment.key}>
              {segment.text}
              {segment.matched ? <wbr /> : null}
            </span>
          ))}
        </code>
        <span className="flex items-center gap-3">
          {links}
          <CopyButton text={command} label={copyLabel} onCopy={onCopy} labels={copyLabels} tone="primary" className="min-w-24" />
        </span>
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted p-3", className)} {...props}>
      <pre role="group" aria-label={label} tabIndex={0} className={cn(focusRing, "min-w-0 overflow-x-auto rounded-sm font-mono text-sm whitespace-pre text-foreground tabular-nums")}>
        <code>{command}</code>
      </pre>
      <div className="flex items-center justify-end gap-3 text-sm">
        {links}
        <CopyButton text={command} label={copyLabel} onCopy={onCopy} labels={copyLabels} variant="labeled" />
      </div>
    </div>
  );
}
