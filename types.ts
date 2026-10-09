export const GROWTHEPIE_PLUGIN_ID = "growthepie";
export const GROWTHEPIE_PANE_ID = "growthepie";

// Links the pane opens in a browser and never fetches, so they stay out of the
// `hosts` the plugin declares: those are the hosts it reaches over the network.
const SITE_HOST = "www.growthepie.com";
const DOCS_HOST = "docs.growthepie.com";

/** Where the pane's `o` key and its source line lead. */
export const GROWTHEPIE_URL = `https://${SITE_HOST}`;
export const GROWTHEPIE_TERMS_URL = `https://${DOCS_HOST}/methodology-caveats/methodology-and-caveats/usage-rules-and-data-tiers`;
export const GROWTHEPIE_SOURCE_LABEL = "growthepie, CC BY 4.0";

export type MetricId =
  | "txcount"
  | "daa"
  | "fees"
  | "txcosts"
  | "throughput"
  | "stables"
  | "tvs";

/** Chart windows. 30D and 90D come from the table's own payload; 1Y and All fetch one chain's history. */
export type RangeId = "30d" | "90d" | "1y" | "all";

/**
 * One daily observation per calendar day starting at `start` (YYYY-MM-DD, UTC).
 * Days the source skipped are null, so an index is always a day offset.
 */
export interface DailySeries {
  start: string;
  values: Array<number | null>;
}

export interface ChainInfo {
  /** growthepie's `origin_key`. */
  id: string;
  name: string;
  shortName: string;
  chainType: string;
  urlKey: string;
  /** The metrics growthepie lists for this chain. */
  metrics: MetricId[];
}

/** What one master.json load keeps: the chains worth showing and when growthepie last updated it. */
export interface MasterData {
  updatedUtc: string | null;
  chains: ChainInfo[];
}

/** What one fundamentals.json load keeps: the last 90 days for each metric and chain. */
export interface FundamentalsData {
  /** Newest observation date across every kept series. */
  asOf: string | null;
  series: Partial<Record<MetricId, Record<string, DailySeries>>>;
}

export interface GrowthepieOverview {
  master: MasterData;
  fundamentals: FundamentalsData;
}

export interface HistoryData {
  /** `last_updated_utc` from the detail payload. */
  updatedUtc: string | null;
  series: DailySeries;
}

export interface CellStat {
  /** Latest observation. */
  value: number | null;
  /** Date of that observation. */
  date: string | null;
  /** Fractional change against 30 days before `date`, or null when it cannot be computed. */
  change30d: number | null;
  /** The newest observation is older than the table's other series. */
  stale: boolean;
}

export interface ChainRow {
  id: string;
  chain: ChainInfo;
  stats: Record<MetricId, CellStat>;
}

export type SortColumnId = "chain" | MetricId | "change";

export interface SortPreference {
  columnId: SortColumnId;
  direction: "asc" | "desc";
}
