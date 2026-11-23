import type { SyntheticEvent } from "react";

const refuse = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export function controlState(disabled = false, busy = false) {
  const blocked = disabled || busy;
  return {
    disabled: disabled && !busy,
    ...(blocked ? { "aria-disabled": true as const, onClickCapture: refuse } : {}),
    ...(busy ? { "aria-busy": true as const } : {}),
  };
}
