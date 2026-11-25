import { type ComponentProps, useState } from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const PFP_COUNT = 150;

function hashSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic fallback avatar path under `/assets/user-pfps/pfp-NNN.jpg` for a given seed string. */
export function getDefaultAvatarUrl(seed: string): string {
  const index = (hashSeed(seed.trim() || "feed") % PFP_COUNT) + 1;
  return `/assets/user-pfps/pfp-${String(index).padStart(3, "0")}.jpg`;
}

const avatarVariants = cva("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground select-none", {
  variants: {
    size: {
      xs: "size-6 text-xs",
      sm: "size-8 text-xs",
      md: "size-10 text-sm",
      lg: "size-16 text-xl",
      xl: "size-20 text-2xl",
    },
  },
  defaultVariants: { size: "md" },
});

export type AvatarProps = Omit<ComponentProps<typeof AvatarPrimitive.Root>, "children"> &
  VariantProps<typeof avatarVariants> & {
    /** Account display name or handle used for fallback initials and accessible naming. */
    name: string;
    /** Optional avatar image URL. */
    src?: string;
    /** Optional explicit fallback image URL tried if `src` fails to load. */
    fallbackSrc?: string;
    /** Deterministic seed used to resolve a `/assets/user-pfps/pfp-NNN.jpg` fallback image. */
    seed?: string;
    /** Hides the avatar from assistive technology when the author name is already rendered beside it. */
    decorative?: boolean;
  };

/** A circular account avatar with automatic fallback image and initials. */
export function Avatar({ name, src, fallbackSrc, seed, size, decorative = true, className, ...props }: AvatarProps) {
  const initial = name.trim().replace(/^@/, "").slice(0, 1).toUpperCase() || "?";
  const secondarySrc = fallbackSrc ?? (seed ? getDefaultAvatarUrl(seed) : src ? getDefaultAvatarUrl(name) : undefined);
  const key = `${src ?? ""}|${secondarySrc ?? ""}`;
  const [fallbackState, setFallbackState] = useState<{ key: string; stage: number }>({ key, stage: 0 });
  const stage = fallbackState.key === key ? fallbackState.stage : 0;

  const activeSrc =
    stage === 0
      ? (src ?? secondarySrc)
      : stage === 1 && src && secondarySrc && secondarySrc !== src
        ? secondarySrc
        : undefined;

  return (
    <AvatarPrimitive.Root {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })} className={cn(avatarVariants({ size }), className)} {...props}>
      {activeSrc ? (
        <AvatarPrimitive.Image
          key={activeSrc}
          src={activeSrc}
          alt=""
          className="size-full object-cover"
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              setFallbackState({ key, stage: stage + 1 });
            }
          }}
        />
      ) : null}
      <AvatarPrimitive.Fallback>{initial}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export type GroupAvatarMember = {
  /** Member display name or handle. */
  name: string;
  /** Optional avatar image URL. */
  src?: string;
  /** Optional deterministic seed for fallback image. */
  seed?: string;
};

export type GroupAvatarProps = {
  /** Up to three members shown in an overlapping cluster. */
  members: GroupAvatarMember[];
  /** Size of the group avatar cluster. */
  size?: "sm" | "md" | "lg";
  /** Additional classes on the outer container. */
  className?: string;
};

const groupOuterSizes = {
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
};

/** Overlapping circular avatar stack for group chat threads. */
export function GroupAvatar({ members, size = "md", className }: GroupAvatarProps) {
  const [first, second] = members;
  if (!first) {
    return <Avatar name="Group" size={size === "lg" ? "md" : size} className={className} />;
  }
  if (!second) {
    return <Avatar name={first.name} src={first.src} seed={first.seed} size={size === "lg" ? "md" : size} className={className} />;
  }
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0", groupOuterSizes[size], className)}>
      <Avatar
        name={first.name}
        src={first.src}
        seed={first.seed}
        size={size === "lg" ? "sm" : "xs"}
        className="absolute top-0 right-0 ring-2 ring-background"
      />
      <Avatar
        name={second.name}
        src={second.src}
        seed={second.seed}
        size={size === "lg" ? "sm" : "xs"}
        className="absolute bottom-0 left-0 ring-2 ring-background"
      />
    </span>
  );
}
