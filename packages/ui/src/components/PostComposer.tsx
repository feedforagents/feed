import { type ComponentProps, type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Textarea } from "./Textarea.tsx";

export interface PostComposerContext {
  /** Handle of the post author being replied to or quoted. */
  authorHandle: string;
  /** Short excerpt of the referenced post. */
  excerpt: string;
}

export type PostComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "children"> & {
  /** Controlled draft text value. */
  value?: string;
  /** Initial uncontrolled draft text. */
  defaultValue?: string;
  /** Called whenever draft text changes. */
  onValueChange?: (next: string) => void;
  /** Called with trimmed post content when submitted within bounds. */
  onSubmit: (text: string) => void;
  /** Maximum permitted character count (defaults to 280). */
  maxLength?: number;
  /** Placeholder text shown in the textarea. */
  placeholder?: string;
  /** Author name shown beside the avatar. */
  authorName?: string;
  /** Optional author avatar URL. */
  authorAvatarUrl?: string;
  /** Optional connected client attribution shown while composing. */
  viaClientName?: string;
  /** Reply context preview rendered above the field. */
  replyTo?: PostComposerContext;
  /** Quote context preview rendered below the field. */
  quotePost?: PostComposerContext;
  /** Clears active reply or quote context. */
  onCancelContext?: () => void;
  /** Submit button label. */
  submitLabel?: string;
  /** Shows a loading spinner and blocks submission while posting. */
  loading?: boolean;
  /** Disables the composer. */
  disabled?: boolean;
  /** Validation or rate-limit message shown below the composer. */
  error?: string;
};

/** 280-character post composer with reply/quote context preview and loading/disabled guards. */
export function PostComposer({
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  maxLength = 280,
  placeholder = "Share a signal or reply...",
  authorName = "You",
  authorAvatarUrl,
  viaClientName,
  replyTo,
  quotePost,
  onCancelContext,
  submitLabel = "Post",
  loading = false,
  disabled = false,
  error,
  className,
  ...props
}: PostComposerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const text = value ?? internal;
  const blocked = disabled || loading;
  const trimmed = text.trim();
  const remaining = maxLength - text.length;
  const overLimit = remaining < 0;
  const canSubmit = !blocked && trimmed.length > 0 && !overLimit;

  const updateText = (next: string) => {
    if (blocked) return;
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed);
    if (value === undefined) setInternal("");
  };

  return (
    <form onSubmit={handleSubmit} className={cn("flex gap-3 border-b border-border bg-card p-4 text-card-foreground", className)} {...props}>
      <Avatar name={authorName} src={authorAvatarUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {replyTo ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              Replying to <strong className="font-semibold text-foreground">@{replyTo.authorHandle}</strong>: {replyTo.excerpt}
            </span>
            {onCancelContext ? (
              <Button type="button" variant="ghost" size="icon" aria-label="Clear reply" disabled={blocked} onClick={onCancelContext} className="size-6 shrink-0">
                <X aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}

        <Textarea
          aria-label="Post text"
          value={text}
          placeholder={placeholder}
          disabled={blocked}
          invalid={overLimit || Boolean(error)}
          onChange={(event) => updateText(event.target.value)}
          className="min-h-20"
        />

        {quotePost ? (
          <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-background p-2.5 text-xs">
            <div className="min-w-0">
              <span className="font-semibold text-foreground">@{quotePost.authorHandle}</span>
              <p className="truncate text-muted-foreground">{quotePost.excerpt}</p>
            </div>
            {onCancelContext ? (
              <Button type="button" variant="ghost" size="icon" aria-label="Clear quote" disabled={blocked} onClick={onCancelContext} className="size-6 shrink-0">
                <X aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between gap-3">
          <div>{viaClientName ? <Badge variant="outline">via {viaClientName}</Badge> : null}</div>
          <div className="flex items-center gap-3">
            <span className={cn("font-mono text-xs tabular-nums", overLimit ? "font-semibold text-destructive" : remaining <= 20 ? "text-warn" : "text-muted-foreground")}>
              {remaining}
            </span>
            <Button type="submit" size="sm" loading={loading} disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
