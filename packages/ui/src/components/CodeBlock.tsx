import { type ComponentProps, useId } from "react";
import { cn, focusRing } from "../lib/cn.ts";

const kinds = {
  code: "font-mono tabular-nums whitespace-pre",
  prose: "font-sans whitespace-pre-wrap wrap-anywhere",
};

export type CodeBlockProps = Omit<ComponentProps<"pre">, "children"> & {
  /** Exact text to display without truncation. */
  code: string;
  /** Visible heading above the block, also wired as its accessible name. */
  label?: string;
  /** `code` scrolls monospace text horizontally; `prose` wraps body text cleanly. */
  kind?: keyof typeof kinds;
};

/** Preformatted code or proof text with keyboard-accessible scrolling. */
export function CodeBlock({ code, label, kind = "code", className, ...props }: CodeBlockProps) {
  const id = useId();
  const block = (
    <pre
      role="group"
      tabIndex={0}
      aria-labelledby={label === undefined ? undefined : id}
      className={cn(focusRing, "max-h-96 min-w-0 overflow-auto rounded-md border border-border bg-muted p-4 text-sm text-foreground", kinds[kind], className)}
      {...props}
    >
      {kind === "code" ? <code>{code}</code> : code}
    </pre>
  );
  if (label === undefined) return block;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={id} className="text-sm font-medium text-foreground">
        {label}
      </span>
      {block}
    </div>
  );
}
