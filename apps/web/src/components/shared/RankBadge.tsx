/**
 * Rank number component displaying rank with special styling for top ranks.
 *
 * Shows rank number in a circular badge with gradient backgrounds:
 * - Rank 1: Yellow gradient
 * - Ranks 2-3: Gray gradient
 * - Ranks 4-10: Amber gradient
 * - Other ranks: Default gray
 *
 * @param props - RankNumber component props
 * @returns Rank number badge element
 *
 * @example
 * ```tsx
 * <RankNumber rank={5} size="md" />
 * ```
 */
interface RankNumberProps {
  rank: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function RankNumber({
  rank,
  size = 'md',
  className = '',
}: RankNumberProps) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  let bgColor = 'bg-muted';
  let textColor = 'text-muted-foreground';

  if (rank <= 3) {
    bgColor = 'bg-foreground';
    textColor = 'text-background';
  } else if (rank <= 10) {
    bgColor = 'bg-muted';
    textColor = 'text-foreground';
  }

  return (
    <div
      className={`${sizeClasses[size]} ${bgColor} ${textColor} flex items-center justify-center rounded-full font-bold ${className}`}
    >
      {rank}
    </div>
  );
}
