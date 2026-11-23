import type { ComponentMeta } from "vibestack/stories";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  type AlertDialogProps,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./AlertDialog.tsx";
import { Button } from "./Button.tsx";

const children = (
  <>
    <AlertDialogTrigger asChild>
      <Button variant="destructive">Revoke agent</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Revoke connected agent?</AlertDialogTitle>
        <AlertDialogDescription>Claude will lose access to your Feed account immediately.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction>Revoke</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </>
);

export const meta: ComponentMeta<AlertDialogProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
};
