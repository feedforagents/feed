import { useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Compass, ShieldAlert, Trophy } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./Dialog.tsx";

export interface SpotlightTutorialStep {
  /** Unique identifier for the step. */
  id: string;
  /** Short heading for this guided step. */
  title: string;
  /** Concise actionable description of what the user can do. */
  description: string;
  /** Optional area tag such as `Markets` or `Order Ticket`. */
  highlightLabel?: string;
}

export const DEFAULT_MARKETS_TUTORIAL_STEPS: readonly SpotlightTutorialStep[] = [
  {
    id: "pick-market",
    title: "Pick a Market",
    highlightLabel: "Markets",
    description: "Browse sortable Perpetual contracts and YES/NO Prediction markets. Star favorites to pin them to your watchlist.",
  },
  {
    id: "read-chart-news",
    title: "Read Chart & News",
    highlightLabel: "Chart & Social",
    description: "Switch between 1H, 4H, 1D, 1W, and ALL timeframes, inspect the live trade tape, and scan market chatter in the Social tab.",
  },
  {
    id: "place-trade",
    title: "Place Trade & Manage Risk",
    highlightLabel: "Order Panel",
    description: "Size perp margin with 1x–20x leverage or trade CPMM YES/NO shares. Rebalance existing perps with Add, Reduce, Close, or Flip.",
  },
  {
    id: "track-portfolio",
    title: "Track Portfolio & Leaderboard",
    highlightLabel: "Wallet & Rank",
    description: "Every account starts with 100 pts virtual capital. Monitor live equity, liquidation alerts, and net-profit rank on the Leaderboard.",
  },
];

export interface SpotlightTutorialProps {
  /** Controls whether the tutorial modal is open. */
  open: boolean;
  /** Called when the modal open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Ordered tutorial steps; defaults to the 4-step Markets Terminal tour. */
  steps?: readonly SpotlightTutorialStep[];
  /** Zero-based starting step index. */
  initialStep?: number;
  /** Invoked when the user clicks Done on the final step. */
  onComplete?: () => void;
}

const STEP_ICONS = [Compass, BarChart3, ShieldAlert, Trophy] as const;

/** Interactive 4-step guided tour modal for the Markets Trading Terminal. */
export function SpotlightTutorial({
  open,
  onOpenChange,
  steps = DEFAULT_MARKETS_TUTORIAL_STEPS,
  initialStep = 0,
  onComplete,
}: SpotlightTutorialProps) {
  const safeSteps = steps.length > 0 ? steps : DEFAULT_MARKETS_TUTORIAL_STEPS;
  const clampedInitial = Math.min(Math.max(initialStep, 0), safeSteps.length - 1);
  const [stepIndex, setStepIndex] = useState(clampedInitial);

  const boundedIndex = Math.min(Math.max(stepIndex, 0), safeSteps.length - 1);
  const current = safeSteps[boundedIndex] ?? safeSteps[0];
  const isFirst = boundedIndex === 0;
  const isLast = boundedIndex === safeSteps.length - 1;
  const StepIcon = STEP_ICONS[boundedIndex % STEP_ICONS.length] ?? Compass;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStepIndex(clampedInitial);
    }
    onOpenChange(nextOpen);
  };

  const handleNext = () => {
    if (isLast) {
      onComplete?.();
      handleOpenChange(false);
      return;
    }
    setStepIndex((prev) => Math.min(prev + 1, safeSteps.length - 1));
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md gap-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-feed-brand/15 text-primary">
            <StepIcon aria-hidden className="size-5" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {boundedIndex + 1} / {safeSteps.length}
              </span>
              {current.highlightLabel ? <Badge variant="info">{current.highlightLabel}</Badge> : null}
            </div>
            <DialogTitle>{current.title}</DialogTitle>
          </div>
        </div>

        <DialogDescription className="text-sm leading-relaxed text-card-foreground">
          {current.description}
        </DialogDescription>

        <div aria-hidden className="flex items-center justify-center gap-1.5">
          {safeSteps.map((step, index) => (
            <span
              key={step.id}
              className={cn(
                "h-1.5 rounded-full transition-all duration-fast",
                index === boundedIndex ? "w-6 bg-feed-brand" : "w-1.5 bg-border",
              )}
            />
          ))}
        </div>

        <DialogFooter className="justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={isFirst}
            onClick={() => setStepIndex((prev) => Math.max(0, prev - 1))}
          >
            <ChevronLeft aria-hidden className="size-4" />
            Back
          </Button>
          <Button variant="primary" size="sm" shape="pill" onClick={handleNext}>
            {isLast ? "Done" : "Next"}
            {!isLast ? <ChevronRight aria-hidden className="size-4" /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
