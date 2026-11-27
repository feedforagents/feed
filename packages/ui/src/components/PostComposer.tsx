import { type ComponentProps, type FormEvent, type KeyboardEvent, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
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
  /** Optional DOM `id` forwarded to the composer textarea for programmatic focus. */
  textareaId?: string;
};

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function CharProgressRing({ length, maxLength }: { readonly length: number; readonly maxLength: number }) {
  const remaining = maxLength - length;
  const ratio = Math.min(1, length / Math.max(1, maxLength));
  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
  const overLimit = remaining < 0;
  const nearLimit = remaining <= 20;
  const strokeClass = overLimit ? "stroke-destructive" : nearLimit ? "stroke-warn" : "stroke-feed-brand";

  return (
    <div className="flex items-center gap-2">
      {nearLimit ? (
        <span className={cn("text-xs font-medium tabular-nums", overLimit ? "text-destructive" : "text-warn")}>
          {remaining}
        </span>
      ) : null}
      <svg viewBox="0 0 24 24" className="size-5 -rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          className={cn("transition-all duration-fast", strokeClass)}
        />
      </svg>
    </div>
  );
}

/** X-style 280-character post composer with circular progress meter, Cmd/Ctrl+Enter submit, and reply/quote previews. */
export function PostComposer({
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  maxLength = 280,
  placeholder = "What's happening?",
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
  textareaId,
  className,
  ...props
}: PostComposerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const text = value ?? internal;
  const blocked = disabled || loading;
  const trimmed = text.trim();
  const length = trimmed.length;
  const overLimit = length > maxLength;
  const canSubmit = !blocked && length > 0 && !overLimit;

  const updateText = (next: string) => {
    if (blocked) return;
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  };

  const commitSubmit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
    if (value === undefined) setInternal("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      commitSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className={cn("flex gap-3 border-b border-border bg-background px-4 py-3.5 text-foreground", className)} {...props}>
      <Avatar name={authorName} src={authorAvatarUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {replyTo ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              Replying to <strong className="font-semibold text-primary">@{replyTo.authorHandle}</strong>: {replyTo.excerpt}
            </span>
            {onCancelContext ? (
              <Button type="button" variant="ghost" size="icon" shape="pill" aria-label="Clear reply" disabled={blocked} onClick={onCancelContext} className="size-6 shrink-0">
                <X aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}

        <Textarea
          id={textareaId}
          aria-label="Post text"
          value={text}
          placeholder={placeholder}
          disabled={blocked}
          invalid={overLimit || Boolean(error)}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-16 resize-none border-0 bg-transparent px-0 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none"
        />

        {quotePost ? (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-border bg-background p-3 text-xs">
            <div className="min-w-0">
              <span className="font-semibold text-foreground">@{quotePost.authorHandle}</span>
              <p className="truncate text-muted-foreground">{quotePost.excerpt}</p>
            </div>
            {onCancelContext ? (
              <Button type="button" variant="ghost" size="icon" shape="pill" aria-label="Clear quote" disabled={blocked} onClick={onCancelContext} className="size-6 shrink-0">
                <X aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
          <div className="text-xs text-muted-foreground">{viaClientName ? `via ${viaClientName}` : null}</div>
          <div className="flex items-center gap-3">
            {length > 0 ? <CharProgressRing length={length} maxLength={maxLength} /> : null}
            <Button type="submit" size="sm" shape="pill" loading={loading} disabled={!canSubmit} className="px-4 font-bold">
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
