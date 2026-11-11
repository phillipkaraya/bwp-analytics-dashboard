"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Numbered } from "@/components/charts/numbered";
import { Section } from "@/components/charts/section";
import { PlatformDot } from "@/components/charts/platform-badge";
import { PLATFORMS, toNum } from "@/lib/derive";
import { fmt, fmtDate, parseDate, platformColor, platformLabel } from "@/lib/format";
import type { FollowerSnapshot, Platform } from "@/lib/types";

/** Two points are a line, not a trend. The chart waits for a third. */
export const MIN_POINTS = 3;

export function FollowerHistory({
  history,
  ordinal,
  platforms = PLATFORMS,
}: {
  history: FollowerSnapshot[];
  ordinal: number;
  /** The platforms of the account in view; every platform by default. */
  platforms?: Platform[];
}) {
  const sorted = [...history]
    .filter((h) => h && h.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < MIN_POINTS) {
    return (
      <Numbered n={ordinal}>
        <Section
          kicker="Growth"
          title="Follower History"
          hint={`Chart appears at ${MIN_POINTS} snapshots. ${sorted.length} so far.`}
        >
          <div className="grid grid-cols-1 min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <p className="text-sm text-ink-soft">
              Every run of the scraper on a new day appends one snapshot of
              every follower count to <code className="font-mono text-xs">follower_history.json</code>.
              Once there are {MIN_POINTS}, this card turns into a line chart per platform. Until then,
              here are the points recorded so far.
            </p>
            <div className="min-w-0 overflow-x-auto">
            <table className="data-table tabular w-full text-sm">
              <thead>
                <tr className="border-y border-border bg-muted/40 text-left">
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                    Snapshot
                  </th>
                  {platforms.map((p) => (
                    <th
                      key={p}
                      className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted"
                    >
                      {platformLabel[p]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={platforms.length + 1} className="px-3 py-6 text-center text-sm text-ink-muted">
                      No snapshots yet.
                    </td>
                  </tr>
                ) : (
                  sorted.map((h) => (
                    <tr key={h.date} className="border-b border-border even:bg-muted/30 last:border-b-0">
                      <td className="px-3 py-2 text-ink">{fmtDate(h.date)}</td>
                      {platforms.map((p) => (
                        <td key={p} className="px-3 py-2 text-right text-ink-soft">
                          {fmt(toNum(h[p]))}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>
        </Section>
      </Numbered>
    );
  }

  const data = sorted.map((h) => ({
    date: parseDate(h.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }),
    ...Object.fromEntries(platforms.map((p) => [p, h[p] === undefined ? null : toNum(h[p])])),
  }));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return (
    <Numbered n={ordinal}>
      <Section
        kicker="Growth"
        title="Follower History"
        hint={`${sorted.length} snapshots, ${fmtDate(first.date)} to ${fmtDate(last.date)}`}
        action={
          <ul className="flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            {platforms.map((p) => {
              // Measure from the first snapshot that has this platform.
              const firstWith = sorted.find((h) => h[p] !== undefined) ?? first;
              const d = toNum(last[p]) - toNum(firstWith[p]);
              return (
                <li key={p} className="flex items-center gap-1.5">
                  <PlatformDot platform={p} />
                  <span className={d > 0 ? "text-positive" : d < 0 ? "text-negative" : ""}>
                    {d > 0 ? "+" : d < 0 ? "−" : ""}
                    {fmt(Math.abs(d))}
                  </span>
                </li>
              );
            })}
          </ul>
        }
      >
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
              />
              <YAxis
                tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmt(v)}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: "var(--brand)", strokeWidth: 1, strokeDasharray: "3 3" }}
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--ink-muted)" }}
                formatter={(v, name) => [
                  fmt(typeof v === "number" ? v : Number(v) || 0),
                  platformLabel[name as Platform] ?? String(name),
                ]}
              />
              <Legend
                iconType="circle"
                iconSize={6}
                formatter={(value) => (
                  <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>
                    {platformLabel[value as Platform] ?? value}
                  </span>
                )}
              />
              {platforms.map((p) => (
                <Line
                  key={p}
                  type="monotone"
                  dataKey={p}
                  stroke={platformColor[p]}
                  strokeWidth={2}
                  dot={{ r: 3, fill: platformColor[p], strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>
    </Numbered>
  );
}
