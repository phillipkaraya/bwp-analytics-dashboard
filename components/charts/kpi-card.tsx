import { numeralShift } from "@/lib/format";
import { cn } from "@/lib/utils";

interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  emphasis?: "default" | "brand";
  align?: "left" | "right";
  className?: string;
}

export function KpiCard({
  label,
  value,
  hint,
  trend,
  emphasis = "default",
  align = "left",
  className,
}: KpiCardProps) {
  return (
    <div
      className={cn(
        "card card-hover p-5",
        emphasis === "brand" && "border-t-2 border-t-brand",
        align === "right" && "text-right",
        className,
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </p>
      <p
        className={cn(
          "tabular mt-2 font-display text-4xl font-semibold leading-none tracking-[-0.02em]",
          emphasis === "brand" ? "text-brand" : "text-ink",
        )}
      style={{ marginLeft: numeralShift(value) }}
      >
        {value}
      </p>
      {(hint || trend) && (
        <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
          {trend && (
            <span
              className={cn(
                "tabular inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
                trend.direction === "up" &&
                  "bg-positive-soft text-positive",
                trend.direction === "down" &&
                  "bg-negative-soft text-negative",
                trend.direction === "flat" && "bg-muted text-ink-muted",
              )}
            >
              {trend.direction === "up"
                ? "▲"
                : trend.direction === "down"
                  ? "▼"
                  : "→"}{" "}
              {trend.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}
