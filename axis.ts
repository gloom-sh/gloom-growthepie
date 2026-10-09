import { formatCurrency } from "gloomberb/utils";
import { metricDef } from "./metrics";
import type { MetricId } from "./types";

const COMPACT_UNITS = [
  { divisor: 1e12, suffix: "T" },
  { divisor: 1e9, suffix: "B" },
  { divisor: 1e6, suffix: "M" },
  { divisor: 1e3, suffix: "k" },
  { divisor: 1, suffix: "" },
] as const;

/** Decimals that keep neighbouring ticks apart: whole units over a wide range, more over a narrow one. */
function spanDecimals(span: number): number {
  if (!Number.isFinite(span) || span >= 10) return 0;
  if (span >= 1) return 1;
  if (span >= 0.1) return 2;
  return 3;
}

/**
 * Axis labels for one metric. Large values share one unit for the whole axis
 * ($50B, $91.25B) with the decimals the plotted range needs, so ticks never
 * repeat; small fees keep enough decimals to tell $0.0012 from $0.0013.
 */
export function formatMetricAxis(
  id: MetricId,
  value: number,
  domain: { min: number; max: number },
): string {
  const unit = metricDef(id).unit;
  const span = Math.abs(domain.max - domain.min);
  if (unit === "usd-fine") {
    const decimals = span >= 1 ? 2 : span >= 0.1 ? 3 : span >= 0.01 ? 4 : span >= 0.001 ? 5 : 6;
    return formatCurrency(value, "USD", decimals);
  }
  if (unit === "mgas") return value.toFixed(spanDecimals(span));
  if (value === 0) return unit === "usd" ? "$0" : "0";
  const top = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  const scale = COMPACT_UNITS.find((entry) => top >= entry.divisor) ?? COMPACT_UNITS[COMPACT_UNITS.length - 1]!;
  const text = `${(value / scale.divisor).toFixed(spanDecimals(span / scale.divisor))}${scale.suffix}`;
  return unit === "usd" ? `$${text}` : text;
}
