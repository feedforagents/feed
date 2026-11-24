import { Award, Medal, Trophy } from "lucide-react";
import { cn } from "../lib/cn.ts";

const iconSizes = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

const labelSizes = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

const numberSizes = {
  sm: "size-6 text-xs",
  md: "size-8 text-sm",
  lg: "size-10 text-base",
};

export type RankBadgeProps = {
  /** One-based leaderboard rank; returns null for ranks above 10. */
  rank: number;
  /** Visual size of the badge icon and label. */
  size?: keyof typeof iconSizes;
  /** Whether to show the rank label beside the trophy/medal icon. */
  showLabel?: boolean;
  /** Additional classes for the wrapper element. */
  className?: string;
};

/** Trophy, medal, or award badge for top-10 leaderboard positions. */
export function RankBadge({ rank, size = "md", showLabel = true, className }: RankBadgeProps) {
  if (rank > 10 || rank < 1) {
    return null;
  }

  const BadgeIcon = rank === 1 ? Trophy : rank <= 3 ? Medal : Award;
  const badgeColor = rank === 1 ? "text-warn" : rank <= 3 ? "text-foreground" : "text-muted-foreground";
  const badgeLabel = rank === 1 ? "1st Place" : rank === 2 ? "2nd Place" : rank === 3 ? "3rd Place" : `Top ${rank}`;

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} aria-label={showLabel ? undefined : badgeLabel}>
      <BadgeIcon aria-hidden className={cn(iconSizes[size], badgeColor, "shrink-0")} strokeWidth={1.75} />
      {showLabel ? <span className={cn("font-semibold", badgeColor, labelSizes[size])}>{badgeLabel}</span> : null}
    </span>
  );
}

export type RankNumberProps = {
  /** One-based leaderboard rank number. */
  rank: number;
  /** Size of the circular rank pill. */
  size?: keyof typeof numberSizes;
  /** Additional classes for the circle container. */
  className?: string;
};

/** Circular numeric rank indicator highlighting top-3 and top-10 placements. */
export function RankNumber({ rank, size = "md", className }: RankNumberProps) {
  const tone =
    rank === 1
      ? "bg-warn/15 text-warn"
      : rank <= 3
        ? "bg-foreground text-background"
        : rank <= 10
          ? "bg-muted text-foreground"
          : "bg-muted text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold tabular-nums",
        numberSizes[size],
        tone,
        className,
      )}
    >
      {rank}
    </span>
  );
}
