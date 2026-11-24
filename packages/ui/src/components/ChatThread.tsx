import { type ComponentProps, type FormEvent, useState } from "react";
import { LogOut, Send, UserPlus } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Input } from "./Input.tsx";

export type ChatKind = "Direct" | "UserGroup" | "NpcAlpha";

export interface ChatReaction {
  /** Reaction emoji or token label. */
  emoji: string;
  /** Number of members who added this reaction. */
  count: number;
  /** Whether the viewer reacted with this emoji. */
  reacted?: boolean;
}

export interface ChatMessageItem {
  /** Message identifier. */
  id: string;
  /** Sender display name. */
  senderName: string;
  /** Sender handle without `@`. */
  senderHandle: string;
  /** Optional avatar URL. */
  senderAvatarUrl?: string;
  /** True when sent by an NPC character. */
  isNpc?: boolean;
  /** True when sent by the current viewer. */
  isOwn?: boolean;
  /** Formatted timestamp string. */
  timestamp: string;
  /** Message body text. */
  content: string;
  /** Optional message reactions. */
  reactions?: ChatReaction[];
}

export type ChatThreadProps = Omit<ComponentProps<"section">, "children"> & {
  /** Thread kind (`Direct`, `UserGroup`, or `NpcAlpha`). */
  chatType: ChatKind;
  /** Thread title or peer name. */
  title: string;
  /** Optional subtitle such as member summary. */
  subtitle?: string;
  /** Active member count in the thread. */
  memberCount?: number;
  /** Unread message count badge. */
  unreadCount?: number;
  /** Ordered chat messages. */
  messages: ChatMessageItem[];
  /** Called when a non-empty message within limit is submitted. */
  onSendMessage?: (text: string) => void;
  /** Called when a reaction chip is toggled. */
  onReact?: (messageId: string, emoji: string) => void;
  /** Marks the thread read. */
  onMarkRead?: () => void;
  /** Opens member invitation flow for a user group chat. */
  onInvite?: () => void;
  /** Leaves a non-owner group or alpha chat. */
  onLeave?: () => void;
  /** Maximum characters per message (defaults to 500). */
  maxMessageChars?: number;
  /** Shows spinner and blocks sends while submitting. */
  loading?: boolean;
  /** Disables interactive thread controls. */
  disabled?: boolean;
};

const chatTypeBadge: Record<ChatKind, { label: string; variant: "outline" | "secondary" | "info" }> = {
  Direct: { label: "DM", variant: "outline" },
  UserGroup: { label: "Group", variant: "secondary" },
  NpcAlpha: { label: "NPC Alpha", variant: "info" },
};

/** Direct, UserGroup, or NPC Alpha chat thread with read indicators, reactions, and 500-char composer. */
export function ChatThread({
  chatType,
  title,
  subtitle,
  memberCount,
  unreadCount = 0,
  messages,
  onSendMessage,
  onReact,
  onMarkRead,
  onInvite,
  onLeave,
  maxMessageChars = 500,
  loading = false,
  disabled = false,
  className,
  ...props
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");
  const blocked = disabled || loading;
  const trimmed = draft.trim();
  const overLimit = draft.length > maxMessageChars;
  const canSend = !blocked && trimmed.length > 0 && !overLimit && Boolean(onSendMessage);
  const badge = chatTypeBadge[chatType];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    onSendMessage?.(trimmed);
    setDraft("");
  };

  return (
    <section aria-label={title} className={cn("flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground", className)} {...props}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {unreadCount > 0 ? <Badge variant="default">{unreadCount} unread</Badge> : null}
          </div>
          {subtitle || memberCount !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {subtitle}
              {subtitle && memberCount !== undefined ? " · " : ""}
              {memberCount !== undefined ? `${memberCount} members` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && onMarkRead ? (
            <Button variant="outline" size="sm" disabled={blocked} onClick={() => !blocked && onMarkRead()}>
              Mark read
            </Button>
          ) : null}
          {chatType === "UserGroup" && onInvite ? (
            <Button variant="outline" size="sm" disabled={blocked} onClick={() => !blocked && onInvite()}>
              <UserPlus aria-hidden className="size-4" />
              Invite
            </Button>
          ) : null}
          {chatType !== "Direct" && onLeave ? (
            <Button variant="ghost" size="sm" disabled={blocked} onClick={() => !blocked && onLeave()}>
              <LogOut aria-hidden className="size-4" />
              Leave
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex max-h-96 min-h-48 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          messages.map((message) => (
            <div key={message.id} className={cn("flex gap-3", message.isOwn && "flex-row-reverse text-right")}>
              <Avatar name={message.senderName} src={message.senderAvatarUrl} size="sm" />
              <div className={cn("flex max-w-md flex-col gap-1", message.isOwn && "items-end")}>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-semibold text-foreground">{message.senderName}</span>
                  <span className="text-muted-foreground">@{message.senderHandle}</span>
                  {message.isNpc ? <Badge variant="info">AI parody</Badge> : null}
                  <span className="text-muted-foreground">{message.timestamp}</span>
                </div>
                <div className={cn("rounded-lg px-3 py-2 text-sm", message.isOwn ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>
                  {message.content}
                </div>
                {message.reactions && message.reactions.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {message.reactions.map((reaction) => (
                      <button
                        key={reaction.emoji}
                        type="button"
                        disabled={blocked}
                        aria-pressed={Boolean(reaction.reacted)}
                        onClick={() => !blocked && onReact?.(message.id, reaction.emoji)}
                        className={cn(
                          focusRing,
                          inactive,
                          "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent",
                          reaction.reacted && "border-primary",
                        )}
                      >
                        <span>{reaction.emoji}</span>
                        <span className="font-mono tabular-nums">{reaction.count}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border bg-background p-3">
        <Input
          aria-label="Message text"
          value={draft}
          disabled={blocked}
          invalid={overLimit}
          placeholder={`Message ${title}...`}
          onChange={(event) => {
            if (!blocked) setDraft(event.target.value);
          }}
        />
        <Button type="submit" size="sm" loading={loading} disabled={!canSend} aria-label="Send message">
          <Send aria-hidden className="size-4" />
          Send
        </Button>
      </form>
    </section>
  );
}
