import { type FocusEvent, useState } from "react";
import { AlertCircle, Check, Clipboard } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button, type ButtonProps } from "./Button.tsx";

export type CopyLabels = { ready: string; copied: string; failed: string };

type CopyStatus = "Ready" | "Copying" | "Copied" | "CopyFailed";

export type CopyButtonProps = Omit<ButtonProps, "children" | "onClick" | "onCopy" | "loading" | "asChild" | "variant" | "size"> & {
  /** Exact text written to the clipboard when activated. */
  text: string;
  /** Clipboard writer callback; defaults to `navigator.clipboard.writeText`. */
  onCopy?: (text: string) => Promise<void>;
  /** Accessible name, and visible label when `variant` is `labeled` without custom `labels`. */
  label?: string;
  /** Compact icon control or labeled button. */
  variant?: "icon" | "labeled";
  /** Optional text displayed per copy status. */
  labels?: CopyLabels;
  /** `primary` emphasizes the main copy CTA and turns `ok` once copied. */
  tone?: "quiet" | "primary";
};

const visibleText = (labels: CopyLabels, status: CopyStatus) => (status === "Copied" ? labels.copied : status === "CopyFailed" ? labels.failed : labels.ready);

const statusMessage = (status: CopyStatus) => (status === "Copied" ? "Copied" : status === "CopyFailed" ? "Copy failed. Select and copy the text." : "");

/** Copies text to the clipboard and clears the copied indicator cleanly on blur or text change. */
export function CopyButton({
  text,
  onCopy = (value) => navigator.clipboard.writeText(value),
  label = "Copy",
  variant = "icon",
  labels,
  tone = "quiet",
  disabled = false,
  onBlur,
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = useState<{ status: CopyStatus; copiedText: string | null }>({ status: "Ready", copiedText: null });
  const activeStatus: CopyStatus = state.status === "Copied" && state.copiedText !== text ? "Ready" : state.status;
  const copied = activeStatus === "Copied";
  const failed = activeStatus === "CopyFailed";
  const copying = activeStatus === "Copying";
  const iconOnly = variant === "icon" && !labels;

  const handlePress = async () => {
    if (disabled || copying) return;
    setState({ status: "Copying", copiedText: null });
    const written = await Promise.resolve(text).then(onCopy).then(
      () => true,
      () => false,
    );
    setState(written ? { status: "Copied", copiedText: text } : { status: "CopyFailed", copiedText: null });
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (state.status === "Copied") setState({ status: "Ready", copiedText: null });
    onBlur?.(event);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={tone === "primary" ? "primary" : iconOnly ? "ghost" : "outline"}
        size={tone === "primary" ? "md" : iconOnly ? "icon" : "sm"}
        aria-label={iconOnly || labels ? label : undefined}
        data-copy={activeStatus}
        disabled={disabled}
        loading={copying}
        onClick={() => void handlePress()}
        onBlur={handleBlur}
        className={cn(tone === "primary" && copied && "bg-ok text-primary-foreground hover:bg-ok", className)}
        {...props}
      >
        {!copying && (failed && tone === "quiet" ? <AlertCircle aria-hidden className="size-4 text-destructive" /> : copied ? <Check aria-hidden className="size-4" /> : <Clipboard aria-hidden className="size-4" />)}
        {labels ? <span data-copy-label>{visibleText(labels, activeStatus)}</span> : variant === "labeled" && label}
      </Button>
      <span role="status" className={failed && !labels ? "text-xs text-destructive" : "sr-only"}>
        {statusMessage(activeStatus)}
      </span>
    </span>
  );
}
