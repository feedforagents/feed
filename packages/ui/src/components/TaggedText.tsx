import { Fragment } from "react";
import { cn, focusRing } from "../lib/cn.ts";

export type TaggedTextProps = {
  /** Plain text body to parse for mentions, hashtags, cashtags, and links. */
  text: string;
  /** Additional classes on the outer container. */
  className?: string;
  /** Enable interactive `$TICKER` cashtag parsing (ignores numeric prices like `$120k`). */
  showCashtags?: boolean;
  /** Invoked when a `@handle` mention is clicked. */
  onMentionClick?: (handle: string) => void;
  /** Invoked when a `#hashtag` is clicked. */
  onHashtagClick?: (tag: string) => void;
  /** Invoked when a `$CASHTAG` is clicked. */
  onCashtagClick?: (symbol: string) => void;
};

type Token =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "mention"; value: string; handle: string }
  | { kind: "hashtag"; value: string; tag: string }
  | { kind: "cashtag"; value: string; symbol: string };

const TOKEN_RE = /(https?:\/\/[^\s<>]+)|((?:^|[\s([{"'])@[A-Za-z0-9_]{1,32})|((?:^|[\s([{"'])#[A-Za-z][A-Za-z0-9_]{0,49})|((?:^|[\s([{"'])\$[A-Za-z][A-Za-z0-9]{0,9}\b)/g;

const TRAILING_PUNCT_RE = /[.,!?;:)\]}]+$/;

function tokenize(text: string, showCashtags: boolean): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    const start = match.index;
    if (start > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, start) });
    }

    if (match[1]) {
      const trailing = TRAILING_PUNCT_RE.exec(raw)?.[0] ?? "";
      const cleanUrl = trailing ? raw.slice(0, -trailing.length) : raw;
      tokens.push({ kind: "url", value: cleanUrl });
      if (trailing) tokens.push({ kind: "text", value: trailing });
    } else if (match[2]) {
      const sigilIdx = raw.indexOf("@");
      if (sigilIdx > 0) tokens.push({ kind: "text", value: raw.slice(0, sigilIdx) });
      const tag = raw.slice(sigilIdx);
      tokens.push({ kind: "mention", value: tag, handle: tag.slice(1) });
    } else if (match[3]) {
      const sigilIdx = raw.indexOf("#");
      if (sigilIdx > 0) tokens.push({ kind: "text", value: raw.slice(0, sigilIdx) });
      const tag = raw.slice(sigilIdx);
      tokens.push({ kind: "hashtag", value: tag, tag: tag.slice(1) });
    } else if (match[4]) {
      if (showCashtags) {
        const sigilIdx = raw.indexOf("$");
        if (sigilIdx > 0) tokens.push({ kind: "text", value: raw.slice(0, sigilIdx) });
        const tag = raw.slice(sigilIdx);
        tokens.push({ kind: "cashtag", value: tag, symbol: tag.slice(1).toUpperCase() });
      } else {
        tokens.push({ kind: "text", value: raw });
      }
    }

    cursor = start + raw.length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
  return tokens;
}

const tagClass = cn(focusRing, "inline cursor-pointer rounded-sm font-medium text-primary hover:underline");

/** Renders post or bio text with interactive `@mentions`, `#hashtags`, `$cashtags`, and external URLs. */
export function TaggedText({
  text,
  className,
  showCashtags = false,
  onMentionClick,
  onHashtagClick,
  onCashtagClick,
}: TaggedTextProps) {
  const tokens = tokenize(text, showCashtags);
  return (
    <span className={cn("wrap-break-word whitespace-pre-wrap", className)}>
      {tokens.map((token, idx) => {
        const key = `${idx}-${token.kind}`;
        switch (token.kind) {
          case "text":
            return <Fragment key={key}>{token.value}</Fragment>;
          case "url":
            return (
              <a
                key={key}
                href={token.value}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={cn(focusRing, "break-all text-primary hover:underline")}
              >
                {token.value}
              </a>
            );
          case "mention":
            return onMentionClick ? (
              <button
                key={key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMentionClick(token.handle);
                }}
                className={tagClass}
              >
                {token.value}
              </button>
            ) : (
              <span key={key} className="font-medium text-primary">
                {token.value}
              </span>
            );
          case "hashtag":
            return onHashtagClick ? (
              <button
                key={key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onHashtagClick(token.tag);
                }}
                className={tagClass}
              >
                {token.value}
              </button>
            ) : (
              <span key={key} className="font-medium text-primary">
                {token.value}
              </span>
            );
          case "cashtag":
            return onCashtagClick ? (
              <button
                key={key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCashtagClick(token.symbol);
                }}
                className={tagClass}
              >
                {token.value}
              </button>
            ) : (
              <span key={key} className="font-medium text-primary">
                {token.value}
              </span>
            );
          default: {
            const _exhaustive: never = token;
            return _exhaustive;
          }
        }
      })}
    </span>
  );
}
