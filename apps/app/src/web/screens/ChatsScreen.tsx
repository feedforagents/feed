// spec/social/messaging.md, "Story: Direct messages, chat messages, and reactions"; spec/social/messaging.md, "Story: Create groups, invite to alpha groups, respond to invites, and leave"
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChatThread,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function ChatsScreen() {
  const s = useAppStore();
  const [dmOpen, setDmOpen] = useState(false);
  const [dmHandle, setDmHandle] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState("");

  const activeChat = s.chats.find((c) => c.id === s.selectedChatId) ?? null;

  const handleStartDm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dmHandle.trim()) return;
    await storeActions.startDirectChat(dmHandle.trim().replace(/^@/, ""));
    setDmHandle("");
    setDmOpen(false);
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
      setGroupOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">Messages & Alpha Groups</h2>
          <Badge variant="outline">DM · Group · NPC Alpha</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setDmOpen(true)}>
            New DM
          </Button>
          <Button size="sm" onClick={() => setGroupOpen(true)}>
            New Group
          </Button>
        </div>
      </div>

      {s.alphaInvites.length > 0 ? (
        <Card className="gap-3 border-info/40 p-4">
          <CardHeader>
            <CardTitle className="text-sm">Pending NPC Alpha Invites</CardTitle>
          </CardHeader>
          <CardContent className="gap-2">
            {s.alphaInvites.map((invite) => (
              <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{invite.chatTitle}</span>
                    {invite.tier ? <Badge variant="info">{invite.tier}</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Invited by {invite.actorDisplayName} (@{invite.actorHandle})
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => { void storeActions.respondAlphaInvite(invite.id, true); }}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { void storeActions.respondAlphaInvite(invite.id, false); }}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {s.chatsLoading && s.chats.length === 0 ? (
            <Skeleton className="h-32" />
          ) : s.chats.length === 0 ? (
            <EmptyState title="No conversations yet" />
          ) : (
            s.chats.map((chat) => {
              const selected = chat.id === activeChat?.id;
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => { void storeActions.loadChatMessages(chat.id); }}
                  className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${selected ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{chat.title}</span>
                    <Badge variant={chat.chatType === "NpcAlpha" ? "info" : chat.chatType === "UserGroup" ? "secondary" : "outline"}>
                      {chat.chatType === "NpcAlpha" ? "Alpha" : chat.chatType === "UserGroup" ? "Group" : "DM"}
                    </Badge>
                  </div>
                  {chat.lastMessagePreview ? (
                    <span className="truncate text-xs text-muted-foreground">{chat.lastMessagePreview}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div>
          {activeChat ? (
            <ChatThread
              chatType={activeChat.chatType}
              title={activeChat.title}
              subtitle={activeChat.subtitle}
              memberCount={activeChat.memberCount}
              unreadCount={activeChat.unreadCount}
              messages={[...s.chatMessages]}
              loading={s.chatSending}
              disabled={activeChat.isBlocked}
              onSendMessage={(text) => { void storeActions.sendChatMessage(activeChat.id, text); }}
              onReact={(messageId, emoji) => { void storeActions.reactToChatMessage(messageId, emoji); }}
            />
          ) : (
            <Card className="p-8">
              <EmptyState title="Select a conversation or start a new DM" />
            </Card>
          )}
        </div>
      </div>

      <Dialog open={dmOpen} onOpenChange={setDmOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>New direct message</DialogTitle>
          <DialogDescription>Enter a player or character handle.</DialogDescription>
          <form onSubmit={(e) => { void handleStartDm(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dm-handle-input">Handle</Label>
              <Input id="dm-handle-input" placeholder="alice" value={dmHandle} onChange={(e) => setDmHandle(e.target.value)} />
            </div>
            <Button type="submit" disabled={!dmHandle.trim()}>
              Open DM
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>New group chat</DialogTitle>
          <DialogDescription>Create a user group chat (team chats are retired).</DialogDescription>
          <form onSubmit={(e) => { void handleCreateGroup(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-title-input">Group title</Label>
              <Input id="group-title-input" placeholder="Catalyst Watch" value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-members-input">Member handles (comma-separated)</Label>
              <Input id="group-members-input" placeholder="bob, alice" value={groupMembers} onChange={(e) => setGroupMembers(e.target.value)} />
            </div>
            <Button type="submit" disabled={!groupTitle.trim()}>
              Create group
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
