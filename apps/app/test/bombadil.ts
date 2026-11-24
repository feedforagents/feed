// spec/app/navigation.md, "Visitors browse public targets and scroll before seeing a delayed sign-in banner"; spec/app/navigation.md, "Mode switching updates surface visibility and redirects away from Markets"
import { always } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";
export * from "@antithesishq/bombadil/browser/defaults";

const singleDialogAtMost = extract(({ document }) => {
  return document.querySelectorAll('[role="dialog"]').length <= 1;
});

const socialModeFinancialNavHidden = extract(({ document }) => {
  const switchEl = document.querySelector('[role="switch"][aria-label="Social mode"]');
  const isSocial = switchEl?.getAttribute("aria-checked") === "true";
  if (!isSocial) return true;
  const navButtons = [...document.querySelectorAll("nav button")];
  return !navButtons.some((button) => {
    const label = button.textContent?.trim();
    return label === "Markets" || label === "Leaderboard";
  });
});

export const neverStacksModals = always(() => singleDialogAtMost.current);

export const socialModeHidesMarkets = always(() => socialModeFinancialNavHidden.current);
