import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { PopoverContent, type PopoverProps, PopoverTrigger } from "./Popover.tsx";

const children = (
  <>
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm">Scope details</Button>
    </PopoverTrigger>
    <PopoverContent aria-label="Scope details">
      <p className="text-sm font-medium text-foreground">Single-agent rule</p>
      <p className="mt-1 text-xs text-muted-foreground">Authorizing a new client replaces any previous grant on this account.</p>
    </PopoverContent>
  </>
);

export const meta: ComponentMeta<PopoverProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
};
