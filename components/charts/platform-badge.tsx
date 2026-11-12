import type { Platform } from "@/lib/types";
import { platformLabel, platformShort } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PlatformBadgeProps {
  platform: Platform;
  size?: "sm" | "md";
  variant?: "solid" | "soft";
  className?: string;
}

const SOFT_BG: Record<Platform, string> = {
  instagram: "bg-[color-mix(in_oklab,var(--ig)_15%,transparent)] text-[color:var(--ig)]",
  tiktok: "bg-[color-mix(in_oklab,var(--tt)_10%,transparent)] text-[color:var(--tt)]",
  youtube: "bg-[color-mix(in_oklab,var(--yt)_15%,transparent)] text-[color:var(--yt)]",
  threads: "bg-[color-mix(in_oklab,var(--th)_10%,transparent)] text-[color:var(--th)]",
  linkedin: "bg-[color-mix(in_oklab,var(--li)_14%,transparent)] text-[color:var(--li)]",
  facebook: "bg-[color-mix(in_oklab,var(--fb)_14%,transparent)] text-[color:var(--fb)]",
  x: "bg-[color-mix(in_oklab,var(--x)_14%,transparent)] text-[color:var(--x)]",
};

const SOLID_BG: Record<Platform, string> = {
  instagram: "bg-[color:var(--ig)] text-white",
  tiktok: "bg-[color:var(--tt)] text-white",
  youtube: "bg-[color:var(--yt)] text-white",
  threads: "bg-[color:var(--th)] text-white",
  linkedin: "bg-[color:var(--li)] text-white",
  facebook: "bg-[color:var(--fb)] text-white",
  x: "bg-[color:var(--x)] text-white",
};

export function PlatformBadge({
  platform,
  size = "sm",
  variant = "soft",
  className,
}: PlatformBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded font-mono uppercase tracking-[0.14em]",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
        variant === "soft" ? SOFT_BG[platform] : SOLID_BG[platform],
        className,
      )}
      title={platformLabel[platform]}
    >
      {platformShort[platform]}
    </span>
  );
}

interface PlatformDotProps {
  platform: Platform;
  className?: string;
}

const DOT_BG: Record<Platform, string> = {
  instagram: "bg-[color:var(--ig)]",
  tiktok: "bg-[color:var(--tt)]",
  youtube: "bg-[color:var(--yt)]",
  threads: "bg-[color:var(--th)]",
  linkedin: "bg-[color:var(--li)]",
  facebook: "bg-[color:var(--fb)]",
  x: "bg-[color:var(--x)]",
};

export function PlatformDot({ platform, className }: PlatformDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        DOT_BG[platform],
        className,
      )}
    />
  );
}
