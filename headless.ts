import type {
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "gloomberb/types/plugin";
import { loadHistory, loadOverview, type CachedResult, type OverviewResult } from "./cache";
import { describeError } from "./client";
import {
  DEFAULT_METRIC,
  DEFAULT_RANGE,
  METRICS,
  RANGES,
  formatChange,
  formatMetricValue,
  formatShortDate,
  isMetricId,
  isRangeId,
  metricDef,
  rangeDef,
  rangeNeedsHistory,
  type MetricDef,
} from "./metrics";
import { defaultSort, resolveChainId, sortRows } from "./model";
import { buildRows, seriesToPoints, sliceSeries, msToDate } from "./normalize";
import {
  GROWTHEPIE_SOURCE_LABEL,
  GROWTHEPIE_TERMS_URL,
  GROWTHEPIE_URL,
  type ChainRow,
  type DailySeries,
  type HistoryData,
  type MetricId,
  type RangeId,
} from "./types";

export interface GrowthepieHeadlessDependencies {
  loadOverview(force: boolean): Promise<OverviewResult>;
  loadHistory(chainId: string, metric: MetricDef, force: boolean): Promise<CachedResult<HistoryData>>;
}

const defaultDependencies: GrowthepieHeadlessDependencies = {
  loadOverview: (force) => loadOverview(force),
  loadHistory: (chainId, metric, force) => loadHistory(chainId, metric, force),
};

export const CHANGE_NOTE = "30D change computed by Gloom from growthepie's daily values";

function metricOption(args: HeadlessPaneLoadArgs): MetricId {
  const value = args.options.metric;
  return isMetricId(value) ? value : DEFAULT_METRIC;
}

function rangeOption(args: HeadlessPaneLoadArgs): RangeId {
  const value = args.options.range;
  return isRangeId(value) ? value : DEFAULT_RANGE;
}

function tableColumns(metric: MetricId): HeadlessPaneColumn[] {
  const selected = metricDef(metric);
  return [
    { key: "chain", header: "Chain" },
    { key: selected.id, header: selected.column, align: "right", format: (value) => formatMetricValue(selected.id, value as number | null) },
    { key: "change30d", header: "30D", align: "right", format: (value) => formatChange(value as number | null) },
    ...METRICS.filter((entry) => entry.id !== metric).map((entry): HeadlessPaneColumn => ({
      key: entry.id,
      header: entry.column,
      align: "right",
      format: (value) => formatMetricValue(entry.id, value as number | null),
    })),
    { key: "date", header: "As of", format: (value) => formatShortDate(value as string | null) },
  ];
}

function tableRow(row: ChainRow, metric: MetricId): Record<string, unknown> {
  const out: Record<string, unknown> = {
    chain: row.chain.shortName,
    chainId: row.id,
    [metric]: row.stats[metric].value,
    change30d: row.stats[metric].change30d,
  };
  for (const entry of METRICS) if (entry.id !== metric) out[entry.id] = row.stats[entry.id].value;
  out.date = row.stats[metric].date;
  return out;
}

function historySection(chain: ChainRow, metric: MetricDef, series: DailySeries): HeadlessBundleSection {
  return {
    title: `${chain.chain.shortName} ${metric.title}`,
    columns: [
      { key: "date", header: "Date" },
      { key: "value", header: metric.column, align: "right", format: (value) => formatMetricValue(metric.id, value as number | null) },
    ],
    rows: seriesToPoints(series)
      .filter((point) => point.value !== null)
      .map((point) => ({ date: msToDate(point.date.getTime()), value: point.value })),
  };
}

/**
 * The pane as data: every chain with the metrics side by side, ranked by the
 * chosen metric, and, when a chain is named, that chain's daily history over
 * the chosen range. The pane's own table and chart are built from the same
 * functions.
 */
export function createGrowthepieHeadless(
  dependencies: GrowthepieHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    description: "Ethereum and Layer-2 chains ranked by one metric, with transactions, active addresses, fees, transaction cost, throughput, stablecoin supply and total value secured side by side, and one chain's daily history on request. Data from growthepie (CC BY 4.0).",
    discovery: {
      aliases: ["growthepie", "l2", "layer 2", "rollups", "chain metrics", "tvl", "stablecoins", "gas fees"],
      dataRequirements: ["growthepie public API (api.growthepie.com), CC BY 4.0"],
      limitations: [
        "Daily values, published once a day.",
        `${CHANGE_NOTE}.`,
        "Not every chain has every metric.",
      ],
    },
    argument: {
      kind: "free-text",
      optional: true,
      placeholder: "chain",
      description: "Chain to include the daily history for, by name or growthepie key (base, optimism, zksync_era).",
    },
    options: [
      {
        key: "metric",
        description: "Metric to rank the chains by and chart.",
        type: "enum",
        values: METRICS.map((metric) => ({ value: metric.id })),
        defaultValue: DEFAULT_METRIC,
        settingKey: "metric",
      },
      {
        key: "range",
        description: "History window for the named chain.",
        type: "enum",
        values: RANGES.map((range) => ({ value: range.id })),
        defaultValue: DEFAULT_RANGE,
        settingKey: "range",
      },
    ],
    describe: (args) => `growthepie | ${metricDef(metricOption(args)).title}`,
    async load(args, ctx) {
      const metric = metricOption(args);
      const def = metricDef(metric);
      const range = rangeOption(args);
      const force = ctx.refresh === true;
      const overview = await dependencies.loadOverview(force);
      const rows = sortRows(buildRows(overview.data.master, overview.data.fundamentals), defaultSort(metric), metric);

      const sections: HeadlessBundleSection[] = [{
        title: "Chains",
        columns: tableColumns(metric),
        rows: rows.map((row) => tableRow(row, metric)),
      }];
      const errors: string[] = [];
      let complete = true;

      const requested = typeof args.argument === "string" ? args.argument.trim() : "";
      let historyChain: string | null = null;
      if (requested) {
        const chainId = resolveChainId(rows, requested);
        const row = rows.find((entry) => entry.id === chainId);
        if (!row) {
          complete = false;
          errors.push(`No chain matches "${requested}".`);
        } else if (!row.chain.metrics.includes(metric) && !overview.data.fundamentals.series[metric]?.[row.id]) {
          complete = false;
          errors.push(`growthepie has no ${def.title.toLowerCase()} for ${row.chain.shortName}.`);
        } else {
          historyChain = row.id;
          let series: DailySeries | undefined = overview.data.fundamentals.series[metric]?.[row.id];
          if (rangeNeedsHistory(range)) {
            try {
              series = (await dependencies.loadHistory(row.id, def, force)).data.series;
            } catch (error) {
              complete = false;
              errors.push(`History for ${row.chain.shortName} is unavailable (${describeError(error)}); showing the last 90 days.`);
            }
          }
          if (series) sections.push(historySection(row, def, sliceSeries(series, rangeDef(range).days)));
        }
      }

      sections.push({
        title: "Source",
        entries: [
          { key: "source", label: "Source", value: GROWTHEPIE_SOURCE_LABEL, formatted: `${GROWTHEPIE_SOURCE_LABEL} (${GROWTHEPIE_URL})` },
          { key: "asOf", label: "Data as of", value: overview.data.fundamentals.asOf, formatted: formatShortDate(overview.data.fundamentals.asOf) },
          { key: "computed", label: "Computed by Gloom", value: CHANGE_NOTE, formatted: CHANGE_NOTE },
        ],
      });

      return {
        sections,
        complete,
        errors: errors.length > 0 ? errors : undefined,
        metadata: {
          metric,
          range,
          chain: historyChain,
          asOf: overview.data.fundamentals.asOf,
          fetchedAt: overview.fetchedAt,
          stale: overview.stale,
          source: GROWTHEPIE_SOURCE_LABEL,
          sourceUrl: GROWTHEPIE_URL,
          terms: GROWTHEPIE_TERMS_URL,
          computed: CHANGE_NOTE,
        },
      };
    },
  };
}

export const growthepieHeadless = createGrowthepieHeadless();
