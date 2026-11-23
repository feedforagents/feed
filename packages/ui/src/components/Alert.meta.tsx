import type { ComponentMeta } from "vibestack/stories";
import type { AlertProps } from "./Alert.tsx";
import { Button } from "./Button.tsx";

export const meta: ComponentMeta<AlertProps> = {
  args: { children: "Open positions remain active while financial surfaces are hidden." },
  examples: {
    Info: { variant: "info", children: "Sign in to place orders and manage positions." },
    Ok: { variant: "ok", children: "Phone verified and 100 pts credited." },
    Warn: { variant: "warn", children: "Open positions remain active in Social mode." },
    Destructive: { variant: "destructive", children: "Order rejected: insufficient points balance." },
    WithAction: { variant: "warn", children: "Open positions may be liquidated in Social mode.", action: <Button variant="outline" size="sm">Switch to Game</Button> },
  },
};
