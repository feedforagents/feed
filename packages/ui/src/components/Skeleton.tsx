import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export type SkeletonProps = Omit<ComponentProps<"div">, "children">;

/** A placeholder in the shape of content still loading; size it with `className`. */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div aria-hidden className={cn("h-4 w-full animate-pulse rounded-md bg-muted", className)} {...props} />;
}

/** Loading skeleton mimicking an X-style feed post row. */
export function PostCardSkeleton({ className, ...props }: SkeletonProps) {
  return (
    <div aria-hidden className={cn("flex gap-3 border-b border-border bg-background px-4 py-3.5", className)} {...props}>
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <div className="mt-1 flex items-center gap-8">
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
        </div>
      </div>
    </div>
  );
}

/** Loading skeleton mimicking a right-rail widget card. */
export function WidgetPanelSkeleton({ className, ...props }: SkeletonProps) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-3 border-b border-border bg-background py-3", className)} {...props}>
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}
