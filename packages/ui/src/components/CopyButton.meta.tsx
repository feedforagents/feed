import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { CopyButtonProps } from "./CopyButton.tsx";

type Context = { canvasElement: HTMLElement };

const written = fn(() => Promise.resolve());
const refused = fn(() => Promise.reject(new Error("Clipboard denied")));
const labels = { ready: "Copy", copied: "Copied", failed: "Select text" };

export const meta: ComponentMeta<CopyButtonProps> = {
  args: { text: "https://feed.fun/SKILL.md" },
  examples: {
    Copies: { onCopy: written },
    Refused: { onCopy: refused },
    Primary: { onCopy: written, label: "Copy agent prompt", labels, tone: "primary" },
  },
  play: {
    Copies: async ({ canvasElement }: Context) => {
      written.mockClear();
      const pendingWrite = Promise.withResolvers<void>();
      written.mockReturnValueOnce(pendingWrite.promise);
      const canvas = within(canvasElement);
      const button = canvas.getByRole("button", { name: "Copy" });
      await userEvent.click(button);
      await expect(written.mock.calls).toEqual([["https://feed.fun/SKILL.md"]]);
      await expect(button).toHaveFocus();
      pendingWrite.resolve();
      await expect(await canvas.findByText("Copied")).toBe(canvas.getByRole("status"));
      button.blur();
      await waitFor(() => expect(button.dataset.copy).toBe("Ready"));
    },
    Refused: async ({ canvasElement }: Context) => {
      refused.mockClear();
      const canvas = within(canvasElement);
      const button = canvas.getByRole("button", { name: "Copy" });
      await userEvent.click(button);
      await waitFor(() => expect(button.dataset.copy).toBe("CopyFailed"));
      await expect(canvas.getByRole("status").textContent).toBe("Copy failed. Select and copy the text.");
    },
  },
};
