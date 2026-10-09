import { compareSortValues, nextHeaderSort } from "gloomberb/utils";
import type { DataTableColumn } from "gloomberb/components";
import { METRICS, metricDef } from "./metrics";
import type { ChainRow, MetricId, SortColumnId, SortPreference } from "./types";

export type GtpColumnId = SortColumnId;

export interface GtpColumn extends Omit<DataTableColumn, "id"> {
  id: GtpColumnId;
}

const CHAIN_WIDTH = 14;
const CHAIN_MIN_WIDTH = 11;
const CHANGE_WIDTH = 9;

const METRIC_WIDTH: Record<MetricId, number> = {
  txcount: 8,
  daa: 11,
  fees: 9,
  txcosts: 9,
  throughput: 9,
  stables: 9,
  tvs: 9,
};

/** The columns that survive a narrow pane, most important first. The chosen metric and its change always stay. */
const KEEP_ORDER: readonly MetricId[] = ["txcount", "fees", "daa", "tvs", "stables", "txcosts", "throughput"];

/** What a kit table spends on its edges, and one column of scrollbar. */
const TABLE_PADDING = 2;
const SCROLLBAR = 1;

function columnSpan(width: number, label: string): number {
  // A header is never drawn narrower than its label plus the sort marker.
  return Math.max(width, label.length + 2) + 1;
}

function metricColumn(id: MetricId): GtpColumn {
  const metric = metricDef(id);
  return { id, label: metric.column, width: METRIC_WIDTH[id], align: "right" };
}

/**
 * The table's columns for a pane width. The chosen metric comes first and its
 * 30-day change right beside it, then every other metric in the order growthepie
 * lists them. A narrow pane loses the least useful metrics from the end of
 * `KEEP_ORDER` before it loses either of those.
 */
export function buildColumns(width: number, selected: MetricId): GtpColumn[] {
  const usable = Math.max(0, Math.floor(width) - SCROLLBAR);
  const chain: GtpColumn = { id: "chain", label: "Chain", width: CHAIN_WIDTH, align: "left" };
  const head: GtpColumn[] = [chain, metricColumn(selected), { id: "change", label: "30D", width: CHANGE_WIDTH, align: "right" }];
  const used = (columns: readonly GtpColumn[]) => columns.reduce(
    (sum, column) => sum + columnSpan(column.width, String(column.label)),
    TABLE_PADDING,
  );

  const kept = new Set<MetricId>();
  let total = used(head);
  for (const id of KEEP_ORDER) {
    if (id === selected) continue;
    const column = metricColumn(id);
    const next = total + columnSpan(column.width, String(column.label));
    if (next > usable) continue;
    kept.add(id);
    total = next;
  }
  const others = METRICS.filter((metric) => metric.id !== selected && kept.has(metric.id)).map((metric) => metricColumn(metric.id));
  const columns = [...head, ...others];

  // A pane too narrow even for the head: give the chain name what is left.
  const overflow = used(columns) - usable;
  if (overflow > 0) {
    const shrunk = Math.max(CHAIN_MIN_WIDTH, CHAIN_WIDTH - overflow);
    columns[0] = { ...chain, width: shrunk };
  }
  return columns;
}

export function defaultSort(metric: MetricId): SortPreference {
  return { columnId: metric, direction: "desc" };
}

export function nextSort(current: SortPreference, columnId: SortColumnId): SortPreference {
  return nextHeaderSort(current, columnId, {
    firstDirection: columnId === "chain" ? "asc" : "desc",
  }) as SortPreference;
}

/** Sorted copy of the rows. A chain with nothing to rank on goes last, whichever way the column runs. */
export function sortRows(rows: readonly ChainRow[], sort: SortPreference, metric: MetricId): ChainRow[] {
  const valueOf = (row: ChainRow): string | number | null => {
    if (sort.columnId === "chain") return row.chain.shortName.toLowerCase();
    if (sort.columnId === "change") return row.stats[metric].change30d;
    return row.stats[sort.columnId].value;
  };
  return [...rows].sort((left, right) => (
    compareSortValues(valueOf(left), valueOf(right), sort.direction)
    || left.chain.shortName.localeCompare(right.chain.shortName)
  ));
}

/**
 * The chain a saved choice or a typed argument names: growthepie's key, or the
 * chain's name in any case. Null leaves the pane on its first row.
 */
export function resolveChainId(rows: readonly ChainRow[], wanted: string | null | undefined): string | null {
  const needle = wanted?.trim().toLowerCase();
  if (!needle) return null;
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compact = squash(needle);
  const match = rows.find(({ chain }) => chain.id === needle)
    ?? rows.find(({ chain }) => squash(chain.id) === compact || squash(chain.name) === compact || squash(chain.shortName) === compact)
    ?? rows.find(({ chain }) => squash(chain.name).startsWith(compact) || squash(chain.shortName).startsWith(compact));
  return match?.id ?? null;
}
