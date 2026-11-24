import { type ComponentProps, type FormEvent, type KeyboardEvent, useState } from "react";
import { ArrowLeft, LogOut, MoreHorizontal, Pencil, Plus, Send, Trash2, UserMinus, UserPlus } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Input } from "./Input.tsx";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./Popover.tsx";
import { Textarea } from "./Textarea.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";

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
  /** Optional peer or group avatar URL rendered in the header. */
  peerAvatarUrl?: string;
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
  /** Mobile back button handler returning to the thread list. */
  onBack?: () => void;
  /** Called when the peer title or avatar in the header is clicked. */
  onPeerClick?: () => void;
  /** Maximum characters per message (defaults to 500). */
  maxMessageChars?: number;
  /** Shows spinner and blocks sends while submitting. */
  loading?: boolean;
  /** Disables interactive thread controls. */
  disabled?: boolean;
};

const QUICK_REACTIONS = ["👍", "🔥", "👀", "🎯", "😂", "💀"] as const;

const chatTypeBadge: Record<ChatKind, { label: string; variant: "outline" | "secondary" | "info" }> = {
  Direct: { label: "DM", variant: "outline" },
  UserGroup: { label: "Group", variant: "secondary" },
  NpcAlpha: { label: "Alpha", variant: "info" },
};

function ChatMessageRow({
  message,
  blocked,
  onReact,
}: {
  readonly message: ChatMessageItem;
  readonly blocked: boolean;
  readonly onReact?: (messageId: string, emoji: string) => void;
}) {
  return (
    <div className={cn("group flex gap-3", message.isOwn && "flex-row-reverse text-right")}>
      <Avatar name={message.senderName} src={message.senderAvatarUrl} seed={message.senderHandle} size="sm" />
      <div className={cn("flex max-w-md flex-col gap-1", message.isOwn && "items-end")}>
        <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", message.isOwn && "justify-end")}>
          <span className="font-semibold text-foreground">{message.senderName}</span>
          {message.isNpc ? <VerifiedBadge size="sm" /> : null}
          <span className="text-muted-foreground">@{message.senderHandle}</span>
          <span className="text-muted-foreground">{message.timestamp}</span>
        </div>

        <div className={cn("rounded-xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap", message.isOwn ? "bg-brand text-brand-foreground" : "bg-muted text-foreground")}>
          {message.content}
        </div>

        <div className={cn("flex flex-wrap items-center gap-1", message.isOwn && "justify-end")}>
          {message.reactions?.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              disabled={blocked}
              aria-pressed={Boolean(reaction.reacted)}
              onClick={() => !blocked && onReact?.(message.id, reaction.emoji)}
              className={cn(
                focusRing,
                inactive,
                "inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent",
                reaction.reacted && "border-brand bg-brand/10",
              )}
            >
              <span>{reaction.emoji}</span>
              <span className="tabular-nums">{reaction.count}</span>
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
                    "inline-flex size-6 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Plus aria-hidden className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align={message.isOwn ? "end" : "start"} className="w-auto p-1.5">
                <div className="flex items-center gap-1">
                  {QUICK_REACTIONS.map((emoji) => (
                    <PopoverClose key={emoji} asChild>
                      <button
                        type="button"
                        disabled={blocked}
                        aria-label={`React with ${emoji}`}
                        onClick={() => !blocked && onReact(message.id, emoji)}
                        className={cn(focusRing, inactive, "flex size-8 items-center justify-center rounded-full text-base hover:bg-accent")}
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
        <Button type="submit" size="sm" shape="pill" disabled={blocked || !renameDraft.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" shape="pill" disabled={blocked} onClick={onClose}>
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
        <Button type="button" variant="ghost" size="sm" shape="pill" disabled={blocked} onClick={onClose}>
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
                className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs"
              >
                <span className="font-medium text-foreground">{member.displayName}</span>
                <span className="text-muted-foreground">@{member.handle}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  shape="pill"
                  disabled={blocked}
                  onClick={() => !blocked && onRemoveMember?.(member.accountId)}
                  className="h-6 px-2 text-xs text-destructive"
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
          <Button type="submit" variant="destructive" size="sm" shape="pill" disabled={blocked || !removeHandleDraft.trim()}>
            Remove
          </Button>
        </form>
      )}
    </div>
  );
}

/** Full-height Direct, UserGroup, or NPC Alpha chat thread with emoji reaction picker, group owner controls, read indicators, and multiline composer. */
export function ChatThread({
  chatType,
  title,
  subtitle,
  peerAvatarUrl,
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
  onBack,
  onPeerClick,
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

  const commitSend = () => {
    if (!canSend) return;
    onSendMessage?.(trimmed);
    setDraft("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commitSend();
    }
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

  const headerTitle = (
    <div className="flex min-w-0 items-center gap-2.5">
      {peerAvatarUrl || chatType === "Direct" ? <Avatar name={title} src={peerAvatarUrl} seed={title} size="sm" /> : null}
      <div className="flex min-w-0 flex-col gap-0.5 text-left">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-bold text-foreground">{title}</h2>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {unreadCount > 0 ? <Badge variant="default">{unreadCount} unread</Badge> : null}
        </div>
        {subtitle || memberCount !== undefined ? (
          <p className="truncate text-xs text-muted-foreground">
            {subtitle}
            {subtitle && memberCount !== undefined ? " · " : ""}
            {memberCount !== undefined ? `${memberCount} members` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <section aria-label={title} className={cn("flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground", className)} {...props}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <Button variant="ghost" size="icon" shape="pill" aria-label="Back to chats" disabled={blocked} onClick={onBack} className="-ml-1.5">
              <ArrowLeft aria-hidden className="size-4" />
            </Button>
          ) : null}
          {onPeerClick ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => !blocked && onPeerClick()}
              className={cn(focusRing, inactive, "min-w-0 rounded-md hover:opacity-85")}
            >
              {headerTitle}
            </button>
          ) : (
            headerTitle
          )}
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && onMarkRead ? (
            <Button variant="outline" size="sm" shape="pill" disabled={blocked} onClick={() => !blocked && onMarkRead()}>
              Mark read
            </Button>
          ) : null}
          {chatType === "UserGroup" && onInvite ? (
            <Button variant="outline" size="sm" shape="pill" disabled={blocked} onClick={() => !blocked && onInvite()}>
              <UserPlus aria-hidden className="size-4" />
              Invite
            </Button>
          ) : null}
          {showOwnerMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" shape="pill" aria-label="Manage group" disabled={blocked}>
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
            <Button variant="ghost" size="sm" shape="pill" disabled={blocked} onClick={() => !blocked && onLeave()}>
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

      <div className="flex min-h-48 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          messages.map((message) => <ChatMessageRow key={message.id} message={message} blocked={blocked} onReact={onReact} />)
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-border bg-background p-3">
        <Textarea
          aria-label="Message text"
          rows={1}
          value={draft}
          disabled={blocked}
          invalid={overLimit}
          placeholder={`Message ${title}...`}
          onChange={(event) => {
            if (!blocked) setDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="min-h-10 max-h-32 resize-none rounded-xl bg-muted/50 py-2"
        />
        <Button type="submit" size="sm" shape="pill" loading={loading} disabled={!canSend} aria-label="Send message" className="h-10 px-4">
          <Send aria-hidden className="size-4" />
          Send
        </Button>
      </form>
    </section>
  );
}
