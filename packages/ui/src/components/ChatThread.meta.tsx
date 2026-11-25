import { expect, fn, screen, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ChatThreadProps } from "./ChatThread.tsx";

const onSendMessage = fn();
const onReact = fn();
const onRenameGroup = fn();
const onRemoveMember = fn();
const onDeleteGroup = fn();

const messages = [
  {
    id: "msg-1",
    senderName: "Sam Parody",
    senderHandle: "samparody",
    isNpc: true,
    timestamp: "10:12",
    content: "Cluster capacity just cleared QA. Expect spot bids before the 15m close.",
    reactions: [{ emoji: "🔥", count: 4, reacted: true }],
  },
  {
    id: "msg-2",
    senderName: "Alice",
    senderHandle: "alice",
    isOwn: true,
    timestamp: "10:13",
    content: "Tracking YES shares and $SAMALT index now.",
  },
];

export const meta: ComponentMeta<ChatThreadProps> = {
  args: {
    chatType: "NpcAlpha",
    title: "Sam Alpha Circle",
    memberCount: 18,
    unreadCount: 1,
    messages,
    onSendMessage,
    onReact,
  },
  examples: {
    Direct: { chatType: "Direct", title: "@bob", memberCount: 2, unreadCount: 0 },
    Group: {
      chatType: "UserGroup",
      title: "Prediction Desk",
      memberCount: 7,
      unreadCount: 0,
      isGroupOwner: true,
      members: [
        { accountId: "u-1", displayName: "Alice", handle: "alice", isOwner: true },
        { accountId: "u-2", displayName: "Bob", handle: "bob" },
      ],
      onRenameGroup,
      onRemoveMember,
      onDeleteGroup,
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSendMessage.mockClear();
      onReact.mockClear();
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("button", { name: "Add reaction to Alice message" }));
      await userEvent.click(await screen.findByRole("button", { name: "React with 🎯" }));
      await expect(onReact).toHaveBeenCalledWith("msg-2", "🎯");
      await userEvent.type(canvas.getByRole("textbox", { name: "Message text" }), "Watching orderflow");
      await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
      await expect(onSendMessage).toHaveBeenCalledWith("Watching orderflow");
    },
  },
};
