import type { ComponentMeta } from "vibestack/stories";
import type { SpinnerProps } from "./Spinner.tsx";

export const meta: ComponentMeta<SpinnerProps> = {
  examples: { Small: { size: "sm" }, Large: { size: "lg", label: "Loading feed" } },
};
