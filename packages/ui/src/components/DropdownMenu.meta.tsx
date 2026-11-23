import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  type DropdownMenuProps,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./DropdownMenu.tsx";

const children = (
  <>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm">Account actions</Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuLabel>@alice</DropdownMenuLabel>
      <DropdownMenuItem>Mute @alice</DropdownMenuItem>
      <DropdownMenuItem>Report account</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive>Block @alice</DropdownMenuItem>
    </DropdownMenuContent>
  </>
);

export const meta: ComponentMeta<DropdownMenuProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
};
