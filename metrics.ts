import { formatCompact, formatCurrency, formatNumber, formatPercent } from "gloomberb/utils";
import type { MetricId, RangeId } from "./types";

export type MetricUnit = "count" | "usd" | "usd-fine" | "mgas";

export interface MetricDef {
  id: MetricId;
  /** growthepie's metric id: the `master.json` key and the metric-detail path segment. */
  apiId: string;
  /** The raw series in `fundamentals.json`. */
  key: string;
  /** Which column of the metric-detail daily series holds this metric. */
  detailColumn: "usd" | "value";
  /** Pane tab. */
  tab: string;
  /** Table column header (the kit uppercases it). */
  column: string;
  /** The metric's name on the chart and in reports. */
  title: string;
  unit: MetricUnit;
}

/**
 * The metrics the pane shows, in column order. Each is one growthepie series
 * that the fundamentals export carries for most chains, so the whole table is
 * one request. Currency metrics use growthepie's USD series.
 */
export const METRICS: readonly MetricDef[] = [
  { id: "txcount", apiId: "txcount", key: "txcount", detailColumn: "value", tab: "Txns", column: "Txns", title: "Transactions", unit: "count" },
  { id: "daa", apiId: "daa", key: "daa", detailColumn: "value", tab: "Addresses", column: "Addresses", title: "Active addresses", unit: "count" },
  { id: "fees", apiId: "fees", key: "fees_paid_usd", detailColumn: "usd", tab: "Fees", column: "Fees", title: "Fees paid", unit: "usd" },
  { id: "txcosts", apiId: "txcosts", key: "txcosts_median_usd", detailColumn: "usd", tab: "Tx cost", column: "Tx cost", title: "Median tx cost", unit: "usd-fine" },
  { id: "throughput", apiId: "throughput", key: "gas_per_second", detailColumn: "value", tab: "Throughput", column: "Mgas/s", title: "Throughput (Mgas/s)", unit: "mgas" },
  { id: "stables", apiId: "stables_mcap", key: "stables_mcap", detailColumn: "usd", tab: "Stables", column: "Stables", title: "Stablecoin supply", unit: "usd" },
  { id: "tvs", apiId: "tvl", key: "tvl", detailColumn: "usd", tab: "TVS", column: "TVS", title: "Total value secured", unit: "usd" },
];

export const DEFAULT_METRIC: MetricId = "txcount";

const METRIC_BY_ID = new Map<string, MetricDef>(METRICS.map((metric) => [metric.id, metric]));
const METRIC_BY_API_ID = new Map<string, MetricDef>(METRICS.map((metric) => [metric.apiId, metric]));
const METRIC_BY_KEY = new Map<string, MetricDef>(METRICS.map((metric) => [metric.key, metric]));

export function metricDef(id: MetricId): MetricDef {
  return METRIC_BY_ID.get(id)!;
}

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === "string" && METRIC_BY_ID.has(value);
}

export function metricByApiId(apiId: string): MetricDef | undefined {
  return METRIC_BY_API_ID.get(apiId);
}

export function metricByKey(key: string): MetricDef | undefined {
  return METRIC_BY_KEY.get(key);
}

export interface RangeDef {
  id: RangeId;
  label: string;
  /** Days of history; null is everything growthepie has. */
  days: number | null;
}

export const RANGES: readonly RangeDef[] = [
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "1y", label: "1Y", days: 365 },
  { id: "all", label: "All", days: null },
];

export const DEFAULT_RANGE: RangeId = "90d";

export function isRangeId(value: unknown): value is RangeId {
  return typeof value === "string" && RANGES.some((range) => range.id === value);
}

export function rangeDef(id: RangeId): RangeDef {
  return RANGES.find((range) => range.id === id)!;
}

/** Ranges the table's own 90-day payload covers; longer ones need one chain's full history. */
export function rangeNeedsHistory(id: RangeId): boolean {
  const days = rangeDef(id).days;
  return days === null || days > 90;
}

const MISSING = "--";

/** Below this a figure is written out ($2,477, 1,954); above it, compact. */
const WRITTEN_OUT_BELOW = 10_000;

/** Compact dollars: $872.8k, $16.23B, and whole dollars while they are few. */
function formatUsd(value: number): string {
  if (Math.abs(value) < WRITTEN_OUT_BELOW) return `${value < 0 ? "-" : ""}$${formatNumber(Math.abs(value), 0)}`;
  return `$${formatCompact(value, { fixedDecimals: true })}`;
}

function formatCount(value: number): string {
  if (Math.abs(value) < WRITTEN_OUT_BELOW) return formatNumber(value, 0);
  return formatCompact(value, { fixedDecimals: true });
}

/** A typical transaction fee: more decimals the cheaper it gets, so $0.0018 does not read $0.00. */
function formatFineUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
  return formatCurrency(value, "USD", digits);
}

/** A figure that rounds to zero carries no sign: -0.00 reads as a loss that is not there. */
function unsignedZero(text: string): string {
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

export function formatMetricValue(id: MetricId, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING;
  switch (metricDef(id).unit) {
    case "count":
      return formatCount(value);
    case "usd":
      return formatUsd(value);
    case "usd-fine":
      return formatFineUsd(value);
    case "mgas":
      return unsignedZero(formatNumber(value, 2));
  }
}

/** A change against the past: +12.34%, and +1.2k% once it is too large for two decimals. */
export function formatChange(change: number | null | undefined): string {
  if (change == null || !Number.isFinite(change)) return MISSING;
  if (Math.abs(change) < 10) return formatPercent(change);
  const percent = change * 100;
  return `${percent > 0 ? "+" : ""}${formatCompact(percent)}%`;
}

export function formatAxisMetricValue(id: MetricId, value: number): string {
  return formatMetricValue(id, value);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-07" as "Oct 7". */
export function formatShortDate(date: string | null | undefined): string {
  if (!date) return MISSING;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : date;
}
