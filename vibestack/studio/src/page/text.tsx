// What the page draws from text: icons, the Markdown specs use, Quint with its keywords marked, and a status dot.
import { useState, type ReactNode } from "react";
import { Button, cn, focusRing } from "@repo/ui";
import { S, select } from "./studio.ts";

const ICONS = {
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  chev: "M6 4l4 4-4 4",
  edit: "M10.5 3.5l2 2L6 12H4v-2z",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8",
  plus: "M8 3.5v9M3.5 8h9",
  check: "M3.5 8.5l3 3 6-7",
  close: "M4 4l8 8M12 4l-8 8",
  play: "M5 3.5l7 4.5-7 4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  undo: "M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3 3 0 010 6H7",
  graph: "M4 4.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM12 4.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM8 10.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM5.5 6h5M5 7.3L7 10.7M11 7.3L9 10.7",
  layout: "M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6",
  split: "M2.5 3.5h11v9h-11zM8 3.5v9",
  stories: "M3 4h10M3 8h7M3 12h9",
  sun: "M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 2v1.2M8 12.8V14M2 8h1.2M12.8 8H14M3.8 3.8l.9.9M11.3 11.3l.9.9M12.2 3.8l-.9.9M4.7 11.3l-.9.9",
  moon: "M12.5 9.8A5 5 0 016.2 3.5a5 5 0 106.3 6.3z",
  search: "M7 3a4 4 0 100 8 4 4 0 000-8zM10 10l3 3",
  external: "M9.5 3h3.5v3.5M13 3L7 9M11 8.5V13H3V5h4.5",
  code: "M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9",
  sidebar: "M2.5 3.5h11v9h-11zM6 3.5v9",
  panelRight: "M2.5 3.5h11v9h-11zM10 3.5v9",
  activity: "M2.5 8.5h2.5l1.8-4 2.4 7 1.8-3h2.5",
  desktop: "M2.5 3.5h11v7.5h-11zM5.5 13h5M8 11v2",
  mobile: "M5 2.5h6v11H5zM7.5 11.5h1",
  inspect: "M3 3l4.2 10 1.6-3.8L12.5 7.5z",
  isolate: "M3 5.5V3h2.5M10.5 3H13v2.5M13 10.5V13h-2.5M5.5 13H3v-2.5M6 6h4v4H6z",
  shield: "M8 2.5l4.5 1.8v3.7c0 2.8-1.9 4.7-4.5 5.5-2.6-.8-4.5-2.7-4.5-5.5V4.3z",
  collapseAll: "M4.5 3.5L8 6.5l3.5-3M4.5 12.5L8 9.5l3.5 3",
  expandAll: "M4.5 6L8 3l3.5 3M4.5 10L8 13l3.5-3",
} as const;
export type IconName = keyof typeof ICONS;

export const Icon = ({ name, className }: { name: IconName; className?: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 flex-none", className)}>
    <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TIP_SIDE = { top: "bottom-full mb-1.5", bottom: "top-full mt-1.5" } as const;
const TIP_ALIGN = { left: "left-0", center: "left-1/2 -translate-x-1/2", right: "right-0" } as const;

/** Instant token-styled tooltip mounted on hover or keyboard focus. */
export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  align = "center",
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom";
  align?: "left" | "center" | "right";
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
    >
      {children}
      {shown && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium whitespace-nowrap text-popover-foreground shadow-md",
            TIP_SIDE[side],
            TIP_ALIGN[align],
          )}
        >
          <span>{label}</span>
          {shortcut && <kbd className="rounded-sm bg-muted px-1 font-mono text-xs text-muted-foreground">{shortcut}</kbd>}
        </span>
      )}
    </span>
  );
}

/** A small button that is only an icon, named by `label` with an instant tooltip. */
export const IconButton = ({
  name,
  label,
  shortcut,
  onClick,
  danger = false,
  active = false,
  disabled = false,
  side = "bottom",
  align = "center",
  className,
}: {
  name: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  side?: "top" | "bottom";
  align?: "left" | "center" | "right";
  className?: string;
}) => (
  <Tooltip label={label} shortcut={shortcut} side={side} align={align}>
    <Button
      variant={active ? "secondary" : "ghost"}
      size="icon"
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        "size-7 text-muted-foreground hover:text-foreground",
        active && "text-primary",
        danger && "hover:text-destructive",
        className,
      )}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <Icon name={name} className="size-3.5" />
    </Button>
  </Tooltip>
);

/** Where a spec, story or rule stands: failing a check, waiting for review, unpublished, or in step (no dot). */
export type Mark = "bad" | "review" | "dirty" | "ok" | "";
const DOT: Record<Mark, string> = { bad: "bg-destructive", review: "bg-warn", dirty: "bg-primary", ok: "bg-ok", "": "" };
export const Dot = ({ mark, label }: { mark: Mark; label: string }) => (
  <span role="img" aria-label={label || "in step"} title={label} className={cn("size-2 flex-none rounded-full", DOT[mark])} />
);

/** Inline Markdown: code, links (to another spec, or out), strong and emphasis. */
function inline(s: string, file: string): ReactNode[] {
  const out: ReactNode[] = [];
  let end = 0;
  for (const m of s.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g)) {
    out.push(s.slice(end, m.index));
    const k = m.index;
    if (m[1]) out.push(<code key={k} className="rounded-sm bg-muted px-1 font-mono">{m[1]}</code>);
    else if (m[2]) {
      let link: URL | undefined;
      try { link = new URL(m[3], new URL(file, "https://spec.invalid/")); } catch { link = undefined; }
      const local = link?.origin === "https://spec.invalid";
      const name = local ? decodeURIComponent(link!.pathname).slice(1).replace(/\/$/, "") : "";
      const target = local && S.specs.find((spec) => !spec.deleted && [name, `${name}.md`, `${name}/index.md`].includes(spec.file));
      out.push(target ? <a key={k} href={`#${encodeURIComponent(target.file)}`} className="text-primary" onClick={(e) => { e.preventDefault(); select(target.file); }}>{m[2]}</a>
        : link && !local && /^https?:$/.test(link.protocol) ? <a key={k} href={link.href} target="_blank" rel="noreferrer" className="text-primary">{m[2]}</a> : m[0]);
    } else if (m[4]) out.push(<strong key={k}>{m[4]}</strong>);
    else out.push(<em key={k}>{m[5]}</em>);
    end = m.index + m[0].length;
  }
  return [...out, s.slice(end)];
}

/** Inline Markdown rendered as a span, for descriptions and labels outside full Markdown blocks. */
export function InlineMarkdown({ text, file = "", className }: { text: string; file?: string; className?: string }) {
  return <span className={className}>{inline(text, file)}</span>;
}

/** Markdown, as far as specs use it: paragraphs, quotes, lists, code and tables kept as written. */
export function Markdown({ text, file, className }: { text: string; file: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {[...text.trim().matchAll(/(?:.|\n(?!\s*\n))+/g)].map(({ 0: block, index: at }) =>
        /^\s*(`{3,}|~{3,})/.test(block) ? <Code key={at}>{block.split("\n").slice(1, -1).join("\n")}</Code>
        : /^\|/.test(block) ? <Code key={at}>{block}</Code>
        : /^>/.test(block) ? <blockquote key={at} className="border-l-3 border-border pl-3">{inline(block.replace(/^>\s?/gm, ""), file)}</blockquote>
        : /^\s*[-*] /.test(block) ? <ul key={at} className="list-disc pl-5">{[...block.matchAll(/^\s*[-*] (.*(?:\n(?!\s*[-*] ).*)*)/gm)].map((l) => <li key={l.index}>{inline(l[1], file)}</li>)}</ul>
        : <p key={at}>{inline(block, file)}</p>)}
    </div>
  );
}

const KEYWORDS = /^(pure|def|val|const|type|import|from|if|else|match|and|or|not|implies|iff|all|any|Set|List|Map|int|bool|str|true|false|module|as)$/;
const KIND = { com: "text-muted-foreground italic", str: "text-ok", num: "text-warn", kw: "text-primary", def: "font-semibold" };
/** Quint, marked: keywords, the names a block defines, strings, numbers and comments. */
export function Quint({ code }: { code: string }) {
  const out: ReactNode[] = [];
  let end = 0;
  for (const match of code.matchAll(/(\/\/.*)|("(?:[^"\\\n]|\\.)*")|\b(\d+)\b|\b([A-Za-z_]\w*)\b/g)) {
    const [text, com, str, num, word] = match;
    out.push(code.slice(end, match.index));
    const kind = com ? "com" : str ? "str" : num ? "num" : KEYWORDS.test(word) ? "kw"
      : /\b(def|val|type)\s+$/.test(code.slice(Math.max(0, match.index - 6), match.index)) ? "def" : undefined;
    out.push(kind ? <span key={match.index} className={KIND[kind]}>{text}</span> : text);
    end = match.index + text.length;
  }
  return <Code>{[...out, code.slice(end)]}</Code>;
}

export const Code = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cn("m-0 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap", className)}>{children}</pre>
);

/** Collapsible inspector section with chevron, title, optional count/meta, and persistent toggle state. */
export function CollapsibleSection({
  label,
  meta,
  defaultOpen = true,
  gap = "gap-1.5",
  children,
}: {
  label: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  gap?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("flex flex-col", gap)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(focusRing, "flex items-center justify-between gap-2 rounded-sm text-left text-xs font-medium text-muted-foreground hover:text-foreground")}
      >
        <span className="flex items-center gap-1">
          <Icon name="chev" className={cn("size-3 transition-transform duration-fast", open && "rotate-90")} />
          <span>{label}</span>
        </span>
        {meta !== undefined && <span className="font-mono text-muted-foreground tabular-nums">{meta}</span>}
      </button>
      {open && children}
    </section>
  );
}

/** Right inspector drawer visibility toggle icon button. */
export const InspectorToggle = ({ open, onToggle }: { open: boolean; onToggle: () => void }) => (
  <IconButton name="panelRight" label={open ? "Hide inspector" : "Show inspector"} active={open} align="right" onClick={onToggle} />
);
