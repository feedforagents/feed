import { expect, screen, userEvent, waitFor } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { SheetClose, SheetContent, SheetDescription, SheetFooter, type SheetProps, SheetTitle, SheetTrigger } from "./Sheet.tsx";

const children = (
  <>
    <SheetTrigger asChild>
      <Button variant="outline">Open drawer</Button>
    </SheetTrigger>
    <SheetContent side="left">
      <SheetTitle>Account</SheetTitle>
      <SheetDescription>Profile and quick navigation.</SheetDescription>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="outline">Done</Button>
        </SheetClose>
      </SheetFooter>
    </SheetContent>
  </>
);

export const meta: ComponentMeta<SheetProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
  play: {
    Default: async () => {
      const trigger = screen.getByRole("button", { name: "Open drawer" });
      await userEvent.click(trigger);
      await expect(await screen.findByRole("dialog", { name: "Account" })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  },
};
