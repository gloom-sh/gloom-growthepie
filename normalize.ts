import { METRICS, metricByApiId, metricByKey, type MetricDef } from "./metrics";
import type {
  CellStat,
  ChainInfo,
  ChainRow,
  DailySeries,
  FundamentalsData,
  HistoryData,
  MasterData,
  MetricId,
} from "./types";

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A series that ends this many days before the newest one is shown as stale. */
export const STALE_AFTER_DAYS = 2;
/** Longer than any real history; a payload that spans more is treated as corrupt. */
const MAX_SERIES_DAYS = 4_000;

/**
 * Aggregate entities that master.json lists beside real chains. Summing them
 * into a chain list would double count, so the table leaves them out.
 */
const AGGREGATE_CHAIN_IDS = new Set(["all_l2s", "multiple"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim() !== "-" ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Dates. Every date is a UTC calendar day, as in growthepie's own exports.

export function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function msToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return msToDate(dateToMs(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateToMs(to) - dateToMs(from)) / DAY_MS);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value) && Number.isFinite(dateToMs(value));
}

// ---------------------------------------------------------------------------
// Series

/** Dense daily series from sparse dated observations. */
export function buildDailySeries(observations: ReadonlyMap<string, number>): DailySeries | null {
  if (observations.size === 0) return null;
  const dates = [...observations.keys()].sort();
  const start = dates[0]!;
  const end = dates[dates.length - 1]!;
  const span = daysBetween(start, end) + 1;
  if (span < 1 || span > MAX_SERIES_DAYS) return null;
  const values: Array<number | null> = new Array(span).fill(null);
  for (const [date, value] of observations) values[daysBetween(start, date)] = value;
  return { start, values };
}

export interface SeriesPoint {
  date: string;
  value: number;
  index: number;
}

/** The newest observation, skipping days the source left empty. */
export function latestPoint(series: DailySeries | null | undefined): SeriesPoint | null {
  if (!series) return null;
  for (let index = series.values.length - 1; index >= 0; index -= 1) {
    const value = series.values[index];
    if (value != null) return { date: addDays(series.start, index), value, index };
  }
  return null;
}

export function seriesEnd(series: DailySeries): string {
  return addDays(series.start, series.values.length - 1);
}

/**
 * Change from `days` before the newest observation to the newest, as a
 * fraction. growthepie publishes the same comparison for its own daily
 * series (`changes.daily.30d`): the latest day against the day 30 days
 * earlier. Null when either day is missing or the earlier one is not above
 * zero, where a ratio would say nothing.
 */
export function changeOver(series: DailySeries | null | undefined, days: number): number | null {
  const last = latestPoint(series);
  if (!last || !series) return null;
  const base = series.values[last.index - days];
  if (base == null || !(base > 0)) return null;
  return last.value / base - 1;
}

/** The last `days` calendar days of a series, or all of it when `days` is null. */
export function sliceSeries(series: DailySeries, days: number | null): DailySeries {
  if (days === null || series.values.length <= days) return series;
  const drop = series.values.length - days;
  return { start: addDays(series.start, drop), values: series.values.slice(drop) };
}

/** Observations as plot points: empty days stay as gaps, trailing empty days are cut. */
export function seriesToPoints(series: DailySeries): Array<{ date: Date; value: number | null }> {
  let end = series.values.length;
  while (end > 0 && series.values[end - 1] == null) end -= 1;
  const startMs = dateToMs(series.start);
  return series.values.slice(0, end).map((value, index) => ({ date: new Date(startMs + index * DAY_MS), value }));
}

// ---------------------------------------------------------------------------
// master.json

export function parseMasterPayload(body: unknown): MasterData {
  if (!isRecord(body) || !isRecord(body.chains)) {
    throw new Error("growthepie returned an unexpected chain list");
  }
  const chains: ChainInfo[] = [];
  for (const [id, raw] of Object.entries(body.chains)) {
    if (!isRecord(raw) || AGGREGATE_CHAIN_IDS.has(id)) continue;
    // growthepie: chains in DEV or ARCHIVED can carry stale data, so they are not shown.
    const deployment = text(raw.deployment ?? raw.deployment_flag)?.toUpperCase();
    if (deployment === "DEV" || deployment === "ARCHIVED") continue;
    const name = text(raw.name) ?? id;
    const supported = Array.isArray(raw.supported_metrics) ? raw.supported_metrics : [];
    const metrics: MetricId[] = [];
    for (const apiId of supported) {
      const metric = typeof apiId === "string" ? metricByApiId(apiId) : undefined;
      if (metric && !metrics.includes(metric.id)) metrics.push(metric.id);
    }
    chains.push({
      id,
      name,
      shortName: text(raw.name_short) ?? name,
      chainType: text(raw.chain_type) ?? "others",
      urlKey: text(raw.url_key) ?? id,
      metrics,
    });
  }
  if (chains.length === 0) throw new Error("growthepie returned no chains");
  return { updatedUtc: text(body.last_updated_utc), chains };
}

// ---------------------------------------------------------------------------
// fundamentals.json

/**
 * The flat export is `{ metric_key, origin_key, date, value }` rows. Only the
 * series the pane shows are kept, as dense daily arrays, which is also what
 * gets stored in the cache.
 */
export function parseFundamentalsPayload(body: unknown): FundamentalsData {
  if (!Array.isArray(body)) throw new Error("growthepie returned an unexpected fundamentals export");
  const byMetric = new Map<MetricId, Map<string, Map<string, number>>>();
  for (const row of body) {
    if (!isRecord(row)) continue;
    const metric = typeof row.metric_key === "string" ? metricByKey(row.metric_key) : undefined;
    const chain = text(row.origin_key);
    const value = finite(row.value);
    if (!metric || !chain || value === null || !isDate(row.date)) continue;
    let chains = byMetric.get(metric.id);
    if (!chains) byMetric.set(metric.id, (chains = new Map()));
    let dates = chains.get(chain);
    if (!dates) chains.set(chain, (dates = new Map()));
    dates.set(row.date, value);
  }

  const series: FundamentalsData["series"] = {};
  let asOf: string | null = null;
  for (const [metricId, chains] of byMetric) {
    const perChain: Record<string, DailySeries> = {};
    for (const [chain, dates] of chains) {
      const daily = buildDailySeries(dates);
      if (!daily) continue;
      perChain[chain] = daily;
      const end = seriesEnd(daily);
      if (!asOf || end > asOf) asOf = end;
    }
    if (Object.keys(perChain).length > 0) series[metricId] = perChain;
  }
  if (!asOf) throw new Error("growthepie returned no data for these metrics");
  return { asOf, series };
}

// ---------------------------------------------------------------------------
// metrics/chains/{chain}/{metric}.json

/** The full daily history of one chain and metric from the metric-detail payload. */
export function parseHistoryPayload(body: unknown, metric: MetricDef): HistoryData {
  const details = isRecord(body) && isRecord(body.details) ? body.details : null;
  const timeseries = details && isRecord(details.timeseries) ? details.timeseries : null;
  const daily = timeseries && isRecord(timeseries.daily) ? timeseries.daily : null;
  if (!daily || !Array.isArray(daily.data) || !Array.isArray(daily.types)) {
    throw new Error("growthepie returned an unexpected history");
  }
  const types = daily.types.map((type) => String(type));
  const unixColumn = Math.max(0, types.indexOf("unix"));
  let valueColumn = types.indexOf(metric.detailColumn);
  if (valueColumn < 0) valueColumn = types.indexOf("value");
  if (valueColumn < 0) valueColumn = types.findIndex((type, index) => type !== "eth" && index !== unixColumn);
  if (valueColumn < 0) throw new Error("growthepie returned an unexpected history");

  const observations = new Map<string, number>();
  for (const entry of daily.data) {
    if (!Array.isArray(entry)) continue;
    const unix = finite(entry[unixColumn]);
    const value = finite(entry[valueColumn]);
    if (unix === null || value === null) continue;
    observations.set(msToDate(unix), value);
  }
  const series = buildDailySeries(observations);
  if (!series) throw new Error("growthepie returned no history for this chain");
  return { updatedUtc: text(isRecord(body) ? body.last_updated_utc : null), series };
}

// ---------------------------------------------------------------------------
// Rows

function cellStat(series: DailySeries | undefined, asOf: string | null): CellStat {
  const last = latestPoint(series);
  if (!last) return { value: null, date: null, change30d: null, stale: false };
  const stale = asOf !== null && daysBetween(last.date, asOf) > STALE_AFTER_DAYS;
  return {
    value: last.value,
    date: last.date,
    // An old observation says nothing about the last 30 days, so it carries no change.
    change30d: stale ? null : changeOver(series, 30),
    stale,
  };
}

export function buildRows(master: MasterData, fundamentals: FundamentalsData): ChainRow[] {
  return master.chains.flatMap((chain): ChainRow[] => {
    const stats = {} as Record<MetricId, CellStat>;
    let any = false;
    for (const metric of METRICS) {
      const series = fundamentals.series[metric.id]?.[chain.id];
      stats[metric.id] = cellStat(series, fundamentals.asOf);
      if (stats[metric.id].value !== null) any = true;
    }
    // A chain growthepie lists but has no recent figures for would be a row of dashes.
    return any ? [{ id: chain.id, chain, stats }] : [];
  });
}

export function filterRows(rows: readonly ChainRow[], query: string): ChainRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(({ chain }) => (
    chain.name.toLowerCase().includes(needle)
    || chain.shortName.toLowerCase().includes(needle)
    || chain.id.toLowerCase().includes(needle)
  ));
}
