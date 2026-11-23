import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { TooltipContent, type TooltipProps, TooltipProvider, TooltipTrigger } from "./Tooltip.tsx";

const children = (
  <>
    <TooltipTrigger asChild>
      <Button variant="outline" size="sm">10 bps fee</Button>
    </TooltipTrigger>
    <TooltipContent>Canonical 0.10% fee rounded up to whole cents.</TooltipContent>
  </>
);

export const meta: ComponentMeta<TooltipProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
  decorator: (Story) => (
    <TooltipProvider>
      <Story />
    </TooltipProvider>
  ),
};
