// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"; spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { useState, type FormEvent } from "react";
import {
  Avatar,
  Badge,
  Button,
  ChatThread,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/ui";
import { MessagePlusIcon, SearchIcon, UsersIcon } from "../icons.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppChatSummary, ExploreAccountHit } from "../types.ts";

type ChatFilterTab = "all" | "dms" | "groups";

function AccountSuggestions({
  accounts,
  onPick,
}: {
  readonly accounts: ReadonlyArray<ExploreAccountHit>;
  readonly onPick: (handle: string) => void;
}) {
  if (accounts.length === 0) return null;

  return (
    <div className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background">
      {accounts.slice(0, 6).map((acct) => (
        <button
          key={acct.accountId}
          type="button"
          onClick={() => onPick(acct.handle)}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent"
        >
          <Avatar name={acct.displayName} src={acct.avatarUrl ?? undefined} seed={acct.handle} size="xs" />
          <span className="truncate font-semibold text-foreground">{acct.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">@{acct.handle}</span>
        </button>
      ))}
    </div>
  );
}

function GroupManagementDialog({
  open,
  onOpenChange,
  chat,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly chat: AppChatSummary | null;
}) {
  const s = useAppStore();
  const [inviteHandle, setInviteHandle] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [transferBusyId, setTransferBusyId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<ExploreAccountHit>>([]);
  const [draftChatId, setDraftChatId] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);

  const chatId = chat?.id ?? null;
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && draftChatId !== chatId) {
      setInviteHandle("");
      setSuggestions([]);
      setDraftChatId(chatId);
    }
  }

  const handleQueryChange = (value: string) => {
    setInviteHandle(value);
    const cleaned = value.trim().replace(/^@/, "");
    if (cleaned.length >= 2) {
      void storeActions.searchAccounts(cleaned).then((res) => { if (res) setSuggestions(res.accounts); });
    } else {
      setSuggestions([]);
    }
  };

  const handleInvite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chat || !inviteHandle.trim()) return;
    setInviteBusy(true);
    const ok = await storeActions.inviteToGroupChat(chat.id, inviteHandle.trim());
    setInviteBusy(false);
    if (ok) {
      setInviteHandle("");
      setSuggestions([]);
    }
  };

  const handleTransferOwnership = async (handle: string, memberId: string) => {
    if (!chat) return;
    setTransferBusyId(memberId);
    await storeActions.transferGroupOwnership(chat.id, handle);
    setTransferBusyId(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogTitle>{chat?.title ?? "Group details"}</DialogTitle>
        <DialogDescription>
          {chat ? `${chat.memberCount} members` : "Manage group members and invites."}
        </DialogDescription>

        {chat ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Members</span>
              <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {chat.members.map((member) => {
                  const canTransferTo =
                    chat.chatType === "UserGroup" &&
                    chat.isOwner &&
                    member.memberKind === "user" &&
                    member.role !== "owner" &&
                    member.memberId !== s.viewer?.accountId;
                  return (
                    <div key={member.memberId} className="flex items-center justify-between gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          void storeActions.navigate(`/u/${encodeURIComponent(member.handle)}`);
                        }}
                        className="flex min-w-0 items-center gap-2 text-left"
                      >
                        <Avatar name={member.displayName} src={member.avatarUrl ?? undefined} seed={member.handle} size="xs" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground hover:underline">{member.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">@{member.handle}</span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {canTransferTo ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            loading={transferBusyId === member.memberId}
                            onClick={() => { void handleTransferOwnership(member.handle, member.memberId); }}
                          >
                            Transfer ownership
                          </Button>
                        ) : null}
                        <Badge variant="outline">{member.role}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {chat.chatType === "UserGroup" && chat.isOwner ? (
              <form onSubmit={(e) => { void handleInvite(e); }} className="flex flex-col gap-2.5 border-t border-border pt-3">
                <Label htmlFor="group-invite-handle">Invite member</Label>
                <div className="flex gap-2">
                  <Input
                    id="group-invite-handle"
                    placeholder="Search @handle..."
                    value={inviteHandle}
                    onChange={(e) => handleQueryChange(e.target.value)}
                  />
                  <Button type="submit" size="sm" loading={inviteBusy} disabled={!inviteHandle.trim()}>
                    Invite
                  </Button>
                </div>
                <AccountSuggestions
                  accounts={suggestions}
                  onPick={(handle) => {
                    setInviteHandle(handle);
                    setSuggestions([]);
                  }}
                />
              </form>
            ) : null}

            {chat.chatType === "NpcAlpha" || (chat.chatType === "UserGroup" && !chat.isOwner) ? (
              <div className="flex justify-end border-t border-border pt-3">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void storeActions.leaveGroupChat(chat.id);
                    onOpenChange(false);
                  }}
                >
                  Leave group
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewChatDialogs({
  dmOpen,
  onDmOpenChange,
  groupOpen,
  onGroupOpenChange,
  onOpenedThread,
}: {
  readonly dmOpen: boolean;
  readonly onDmOpenChange: (open: boolean) => void;
  readonly groupOpen: boolean;
  readonly onGroupOpenChange: (open: boolean) => void;
  readonly onOpenedThread: () => void;
}) {
  const [dmHandle, setDmHandle] = useState("");
  const [dmBusy, setDmBusy] = useState(false);
  const [dmAccounts, setDmAccounts] = useState<ReadonlyArray<ExploreAccountHit>>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupAccounts, setGroupAccounts] = useState<ReadonlyArray<ExploreAccountHit>>([]);

  const handleStartDm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dmHandle.trim()) return;
    setDmBusy(true);
    const ok = await storeActions.startDirectChat(dmHandle.trim().replace(/^@/, ""));
    setDmBusy(false);
    if (ok) {
      setDmHandle("");
      setDmAccounts([]);
      onDmOpenChange(false);
      onOpenedThread();
    }
  };

  const handleCreateGroup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!groupTitle.trim()) return;
    const handles = groupMembers
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    const ok = await storeActions.createGroupChat(groupTitle.trim(), handles);
    if (ok) {
      setGroupTitle("");
      setGroupMembers("");
      setGroupSearch("");
      setGroupAccounts([]);
      onGroupOpenChange(false);
      onOpenedThread();
    }
  };

  const addMemberToDraft = (handle: string) => {
    const existing = groupMembers
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (!existing.includes(handle)) {
      setGroupMembers([...existing, handle].join(", "));
    }
    setGroupSearch("");
    setGroupAccounts([]);
  };

  return (
    <>
      <Dialog open={dmOpen} onOpenChange={onDmOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>Search for a player account to start a direct message.</DialogDescription>
          <form onSubmit={(e) => { void handleStartDm(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dm-handle-input">Handle</Label>
              <Input
                id="dm-handle-input"
                placeholder="Search @handle..."
                value={dmHandle}
                onChange={(e) => {
                  const val = e.target.value;
                  setDmHandle(val);
                  const cleaned = val.trim().replace(/^@/, "");
                  if (cleaned.length >= 2) {
                    void storeActions.searchAccounts(cleaned).then((res) => { if (res) setDmAccounts(res.accounts); });
                  } else {
                    setDmAccounts([]);
                  }
                }}
              />
            </div>
            <AccountSuggestions
              accounts={dmAccounts}
              onPick={(handle) => {
                setDmHandle(handle);
                setDmAccounts([]);
              }}
            />
            <Button type="submit" loading={dmBusy} disabled={!dmHandle.trim()}>
              Start chat
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={groupOpen} onOpenChange={onGroupOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogTitle>New group chat</DialogTitle>
          <DialogDescription>Name your group and add player members by handle.</DialogDescription>
          <form onSubmit={(e) => { void handleCreateGroup(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-title-input">Group name</Label>
              <Input
                id="group-title-input"
                placeholder="Catalyst Watch"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-search-input">Add people</Label>
              <Input
                id="group-search-input"
                placeholder="Search handles..."
                value={groupSearch}
                onChange={(e) => {
                  const val = e.target.value;
                  setGroupSearch(val);
                  const cleaned = val.trim().replace(/^@/, "");
                  if (cleaned.length >= 2) {
                    void storeActions.searchAccounts(cleaned).then((res) => { if (res) setGroupAccounts(res.accounts); });
                  } else {
                    setGroupAccounts([]);
                  }
                }}
              />
              <AccountSuggestions accounts={groupAccounts} onPick={addMemberToDraft} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-members-input">Selected handles</Label>
              <Input
                id="group-members-input"
                placeholder="alice, bob"
                value={groupMembers}
                onChange={(e) => setGroupMembers(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={!groupTitle.trim()}>
              Create group
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChatsScreen() {
  const s = useAppStore();
  const [chatTab, setChatTab] = useState<ChatFilterTab>("all");
  const [searchText, setSearchText] = useState("");
  const arrivedViaChatParam = typeof window !== "undefined" && Boolean(new URLSearchParams(window.location.search).get("chat"));
  const [mobileShowThread, setMobileShowThread] = useState(arrivedViaChatParam);
  const [dmOpen, setDmOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const activeChat = s.chats.find((c) => c.id === s.selectedChatId) ?? null;

  const filteredChats = s.chats.filter((chat) => {
    if (chatTab === "dms" && chat.chatType !== "Direct") return false;
    if (chatTab === "groups" && chat.chatType === "Direct") return false;
    const q = searchText.trim().toLowerCase();
    if (!q) return true;
    return chat.title.toLowerCase().includes(q)
      || chat.subtitle.toLowerCase().includes(q)
      || (chat.lastMessagePreview?.toLowerCase().includes(q) ?? false);
  });

  const handleSelectChat = (chatId: string) => {
    setMobileShowThread(true);
    void storeActions.selectChat(chatId);
  };

  return (
    <div className="flex h-[calc(100dvh-53px-4rem-env(safe-area-inset-bottom))] min-h-0 flex-1 overflow-hidden md:h-dvh">
      <aside
        className={`flex min-h-0 w-full shrink-0 flex-col border-r border-border bg-background md:w-80 ${mobileShowThread ? "hidden md:flex" : "flex"}`}
      >
        <div className="flex h-[53px] items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex items-center gap-2">
            <h1 className="hidden text-base font-bold text-foreground md:block">Chats</h1>
            <span
              aria-label={s.sseConnected ? "Connected" : "Reconnecting"}
              className={`size-2 rounded-full ${s.sseConnected ? "bg-ok" : "bg-muted-foreground/50"}`}
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              shape="pill"
              aria-label="New direct message"
              onClick={() => setDmOpen(true)}
            >
              <MessagePlusIcon className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              shape="pill"
              aria-label="New group chat"
              onClick={() => setGroupOpen(true)}
            >
              <UsersIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search chats"
              placeholder="Search messages"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="h-9 rounded-full border-transparent bg-muted pr-3 pl-9 focus-visible:border-feed-brand focus-visible:bg-background"
            />
          </div>
        </div>

        <Tabs
          value={chatTab}
          onValueChange={(next) => {
            if (next === "all" || next === "dms" || next === "groups") setChatTab(next);
          }}
        >
          <TabsList variant="underline">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="dms">DMs</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex-1 overflow-y-auto">
          {s.alphaInvites.length > 0 ? (
            <div className="border-b border-border bg-feed-brand/5 p-3">
              <p className="mb-2 text-xs font-bold text-primary">Pending Invites ({s.alphaInvites.length})</p>
              <div className="flex flex-col gap-2">
                {s.alphaInvites.map((invite) => (
                  <div key={invite.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar
                        name={invite.actorDisplayName}
                        src={invite.actorAvatarUrl ?? undefined}
                        seed={invite.actorHandle}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-bold text-foreground">{invite.chatTitle}</p>
                          <Badge variant={invite.isAlpha ? "info" : "secondary"}>
                            {invite.isAlpha ? "Alpha" : "Group"}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">from @{invite.actorHandle}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" className="flex-1" onClick={() => { void storeActions.respondGroupInvite(invite.id, true); }}>
                        Accept
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => { void storeActions.respondGroupInvite(invite.id, false); }}>
                        Decline
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {s.chatsLoading && s.chats.length === 0 ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : filteredChats.length === 0 ? (
            <EmptyState title="No conversations" />
          ) : (
            <div className="divide-y divide-border">
              {filteredChats.map((chat) => {
                const selected = chat.id === activeChat?.id;
                return (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => handleSelectChat(chat.id)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-fast ${selected ? "bg-accent" : "hover:bg-muted/40"}`}
                  >
                    <Avatar
                      name={chat.title}
                      src={chat.peerAvatarUrl ?? undefined}
                      seed={chat.peerHandle ?? chat.id}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-bold text-foreground">{chat.title}</span>
                        {chat.unreadCount > 0 ? (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-feed-brand px-1.5 text-[11px] font-bold text-feed-brand-foreground tabular-nums">
                            {chat.unreadCount}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {chat.lastMessagePreview ?? chat.subtitle}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${mobileShowThread ? "flex" : "hidden md:flex"}`}>
        {activeChat ? (
          <ChatThread
            key={activeChat.id}
            chatType={activeChat.chatType}
            title={activeChat.title}
            subtitle={activeChat.subtitle}
            peerAvatarUrl={activeChat.peerAvatarUrl ?? undefined}
            memberCount={activeChat.memberCount}
            unreadCount={activeChat.unreadCount}
            messages={[...s.chatMessages]}
            isGroupOwner={activeChat.chatType === "UserGroup" && activeChat.isOwner}
            members={activeChat.members.map((m) => ({
              accountId: m.memberId,
              displayName: m.displayName,
              handle: m.handle,
              isOwner: m.role === "owner",
            }))}
            loading={s.chatSending}
            disabled={activeChat.isBlocked}
            onBack={() => setMobileShowThread(false)}
            onPeerClick={
              activeChat.chatType === "Direct" && activeChat.peerHandle
                ? () => { void storeActions.navigate(`/u/${encodeURIComponent(activeChat.peerHandle ?? "")}`); }
                : activeChat.chatType !== "Direct"
                  ? () => setManageOpen(true)
                  : undefined
            }
            onMarkRead={() => { void storeActions.markChatRead(activeChat.id); }}
            onInvite={activeChat.chatType === "UserGroup" && activeChat.isOwner ? () => setManageOpen(true) : undefined}
            onRenameGroup={
              activeChat.chatType === "UserGroup" && activeChat.isOwner
                ? (nextTitle) => { void storeActions.renameGroupChat(activeChat.id, nextTitle); }
                : undefined
            }
            onRemoveMember={
              activeChat.chatType === "UserGroup" && activeChat.isOwner
                ? (target) => { void storeActions.removeGroupMember(activeChat.id, target); }
                : undefined
            }
            onDeleteGroup={
              activeChat.chatType === "UserGroup" && activeChat.isOwner
                ? () => { void storeActions.deleteGroupChat(activeChat.id); }
                : undefined
            }
            onLeave={
              activeChat.chatType === "NpcAlpha" || (activeChat.chatType === "UserGroup" && !activeChat.isOwner)
                ? () => { void storeActions.leaveGroupChat(activeChat.id); }
                : undefined
            }
            onSendMessage={(text) => storeActions.sendChatMessage(activeChat.id, text)}
            onReact={(messageId, emoji) => { void storeActions.reactToChatMessage(messageId, emoji); }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState title="Select a conversation">
              <Button onClick={() => setDmOpen(true)}>
                New message
              </Button>
            </EmptyState>
          </div>
        )}
      </div>

      <GroupManagementDialog open={manageOpen} onOpenChange={setManageOpen} chat={activeChat} />

      <NewChatDialogs
        dmOpen={dmOpen}
        onDmOpenChange={setDmOpen}
        groupOpen={groupOpen}
        onGroupOpenChange={setGroupOpen}
        onOpenedThread={() => setMobileShowThread(true)}
      />
    </div>
  );
}
