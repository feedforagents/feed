import { type ComponentProps, type FormEvent, useState } from "react";
import { LogOut, MoreHorizontal, Pencil, Send, SmilePlus, Trash2, UserMinus, UserPlus } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Input } from "./Input.tsx";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./Popover.tsx";

export type ChatKind = "Direct" | "UserGroup" | "NpcAlpha";

export interface ChatReaction {
  /** Reaction emoji or token label. */
  emoji: string;
  /** Number of members who added this reaction. */
  count: number;
  /** Whether the viewer reacted with this emoji. */
  reacted?: boolean;
}

export interface ChatMemberItem {
  /** Member account identifier. */
  accountId: string;
  /** Member display name. */
  displayName: string;
  /** Member handle without `@`. */
  handle: string;
  /** True when this member owns the group. */
  isOwner?: boolean;
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
  /** Whether the signed-in viewer owns this user group (enables rename, remove member, and delete controls). */
  isGroupOwner?: boolean;
  /** Optional member roster used for owner member removal. */
  members?: ChatMemberItem[];
  /** Called when a non-empty message within limit is submitted. */
  onSendMessage?: (text: string) => void;
  /** Called when a reaction chip or picker emoji is toggled. */
  onReact?: (messageId: string, emoji: string) => void;
  /** Marks the thread read. */
  onMarkRead?: () => void;
  /** Opens member invitation flow for a user group chat. */
  onInvite?: () => void;
  /** Renames a user group chat when the owner submits a new title. */
  onRenameGroup?: (nextTitle: string) => void;
  /** Removes a member by `accountId` (or handle when `members` is omitted). */
  onRemoveMember?: (memberIdOrHandle: string) => void;
  /** Deletes a user group chat when invoked by the group owner. */
  onDeleteGroup?: () => void;
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

const quickReactionEmojis = ["👍", "🔥", "👀", "🎯", "😂", "💀"] as const;

function ChatMessageRow({
  message,
  blocked,
  onReact,
}: {
  readonly message: ChatMessageItem;
  readonly blocked: boolean;
  readonly onReact?: (messageId: string, emoji: string) => void;
}) {
  const existingReactions = message.reactions ?? [];
  const showReactionBar = existingReactions.length > 0 || Boolean(onReact);

  return (
    <div className={cn("flex gap-3", message.isOwn && "flex-row-reverse text-right")}>
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
        {showReactionBar ? (
          <div className={cn("flex flex-wrap items-center gap-1", message.isOwn && "justify-end")}>
            {existingReactions.map((reaction) => (
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
            {onReact ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={blocked}
                    aria-label={`Add reaction to ${message.senderName} message`}
                    className={cn(
                      focusRing,
                      inactive,
                      "inline-flex items-center justify-center rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <SmilePlus aria-hidden className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align={message.isOwn ? "end" : "start"} className="w-auto p-1.5">
                  <div className="flex items-center gap-1">
                    {quickReactionEmojis.map((emoji) => (
                      <PopoverClose key={emoji} asChild>
                        <button
                          type="button"
                          disabled={blocked}
                          aria-label={`React with ${emoji}`}
                          onClick={() => !blocked && onReact(message.id, emoji)}
                          className={cn(focusRing, inactive, "flex size-8 items-center justify-center rounded-md text-base hover:bg-accent")}
                        >
                          {emoji}
                        </button>
                      </PopoverClose>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChatOwnerManageBar({
  panel,
  blocked,
  renameDraft,
  onRenameDraftChange,
  onSubmitRename,
  removeHandleDraft,
  onRemoveHandleDraftChange,
  onSubmitRemoveHandle,
  members,
  onRemoveMember,
  onClose,
}: {
  readonly panel: "rename" | "members";
  readonly blocked: boolean;
  readonly renameDraft: string;
  readonly onRenameDraftChange: (value: string) => void;
  readonly onSubmitRename: (event: FormEvent<HTMLFormElement>) => void;
  readonly removeHandleDraft: string;
  readonly onRemoveHandleDraftChange: (value: string) => void;
  readonly onSubmitRemoveHandle: (event: FormEvent<HTMLFormElement>) => void;
  readonly members?: ChatMemberItem[];
  readonly onRemoveMember?: (memberIdOrHandle: string) => void;
  readonly onClose: () => void;
}) {
  if (panel === "rename") {
    return (
      <form onSubmit={onSubmitRename} className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2.5">
        <Input
          aria-label="New group title"
          value={renameDraft}
          disabled={blocked}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          placeholder="Group title"
        />
        <Button type="submit" size="sm" disabled={blocked || !renameDraft.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={onClose}>
          Cancel
        </Button>
      </form>
    );
  }

  const removableMembers = (members ?? []).filter((member) => !member.isOwner);
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-muted px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Remove member</span>
        <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={onClose}>
          Done
        </Button>
      </div>
      {members !== undefined ? (
        removableMembers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No removable members in this group.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {removableMembers.map((member) => (
              <div
                key={member.accountId}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1 text-xs"
              >
                <span className="font-medium text-foreground">{member.displayName}</span>
                <span className="text-muted-foreground">@{member.handle}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={blocked}
                  onClick={() => !blocked && onRemoveMember?.(member.accountId)}
                  className="h-6 px-1.5 text-xs text-destructive"
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )
      ) : (
        <form onSubmit={onSubmitRemoveHandle} className="flex items-center gap-2">
          <Input
            aria-label="Member handle to remove"
            value={removeHandleDraft}
            disabled={blocked}
            placeholder="handle"
            onChange={(event) => onRemoveHandleDraftChange(event.target.value)}
          />
          <Button type="submit" variant="destructive" size="sm" disabled={blocked || !removeHandleDraft.trim()}>
            Remove
          </Button>
        </form>
      )}
    </div>
  );
}

/** Direct, UserGroup, or NPC Alpha chat thread with read indicators, reaction picker, group management, and 500-char composer. */
export function ChatThread({
  chatType,
  title,
  subtitle,
  memberCount,
  unreadCount = 0,
  messages,
  isGroupOwner = false,
  members,
  onSendMessage,
  onReact,
  onMarkRead,
  onInvite,
  onRenameGroup,
  onRemoveMember,
  onDeleteGroup,
  onLeave,
  maxMessageChars = 500,
  loading = false,
  disabled = false,
  className,
  ...props
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");
  const [managePanel, setManagePanel] = useState<"none" | "rename" | "members">("none");
  const [renameDraft, setRenameDraft] = useState(title);
  const [removeHandleDraft, setRemoveHandleDraft] = useState("");

  const blocked = disabled || loading;
  const trimmed = draft.trim();
  const overLimit = draft.length > maxMessageChars;
  const canSend = !blocked && trimmed.length > 0 && !overLimit && Boolean(onSendMessage);
  const badge = chatTypeBadge[chatType];
  const showOwnerMenu = chatType === "UserGroup" && isGroupOwner && Boolean(onRenameGroup || onRemoveMember || onDeleteGroup);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    onSendMessage?.(trimmed);
    setDraft("");
  };

  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = renameDraft.trim();
    if (blocked || !next || !onRenameGroup) return;
    onRenameGroup(next);
    setManagePanel("none");
  };

  const handleRemoveHandleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = removeHandleDraft.trim().replace(/^@/, "");
    if (blocked || !next || !onRemoveMember) return;
    onRemoveMember(next);
    setRemoveHandleDraft("");
    setManagePanel("none");
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
          {showOwnerMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Manage group" disabled={blocked}>
                  <MoreHorizontal aria-hidden className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onRenameGroup ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      if (blocked) return;
                      setRenameDraft(title);
                      setManagePanel("rename");
                    }}
                  >
                    <Pencil aria-hidden className="size-4" />
                    Rename group
                  </DropdownMenuItem>
                ) : null}
                {onRemoveMember ? (
                  <DropdownMenuItem onSelect={() => !blocked && setManagePanel("members")}>
                    <UserMinus aria-hidden className="size-4" />
                    Remove member
                  </DropdownMenuItem>
                ) : null}
                {onDeleteGroup ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => !blocked && onDeleteGroup()}>
                      <Trash2 aria-hidden className="size-4" />
                      Delete group
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {chatType !== "Direct" && onLeave ? (
            <Button variant="ghost" size="sm" disabled={blocked} onClick={() => !blocked && onLeave()}>
              <LogOut aria-hidden className="size-4" />
              Leave
            </Button>
          ) : null}
        </div>
      </header>

      {managePanel !== "none" ? (
        <ChatOwnerManageBar
          panel={managePanel}
          blocked={blocked}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onSubmitRename={handleRenameSubmit}
          removeHandleDraft={removeHandleDraft}
          onRemoveHandleDraftChange={setRemoveHandleDraft}
          onSubmitRemoveHandle={handleRemoveHandleSubmit}
          members={members}
          onRemoveMember={onRemoveMember}
          onClose={() => setManagePanel("none")}
        />
      ) : null}

      <div className="flex max-h-96 min-h-48 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          messages.map((message) => <ChatMessageRow key={message.id} message={message} blocked={blocked} onReact={onReact} />)
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
