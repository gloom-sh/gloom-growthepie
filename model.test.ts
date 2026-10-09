import { describe, expect, test } from "bun:test";
import { buildColumns, defaultSort, nextSort, resolveChainId, sortRows } from "./model";
import type { CellStat, ChainRow, MetricId } from "./types";

const EMPTY: CellStat = { value: null, date: null, change30d: null, stale: false };

function row(id: string, shortName: string, stats: Partial<Record<MetricId, Partial<CellStat>>>): ChainRow {
  const all = {} as Record<MetricId, CellStat>;
  for (const metric of ["txcount", "daa", "fees", "txcosts", "throughput", "stables", "tvs"] as const) {
    all[metric] = { ...EMPTY, ...stats[metric] };
  }
  return { id, chain: { id, name: shortName, shortName, chainType: "rollup", urlKey: id, metrics: [] }, stats: all };
}

const rows = [
  row("base", "Base", { txcount: { value: 8, change30d: -0.1 }, fees: { value: 1, change30d: 0.5 } }),
  row("arbitrum", "Arbitrum", { txcount: { value: 3, change30d: 0.2 }, fees: { value: 9, change30d: null } }),
  row("ethereum", "Ethereum L1", { txcount: { value: 2, change30d: 0.01 } }),
  row("zksync_era", "ZKsync Era", { fees: { value: 4, change30d: -0.7 } }),
];

describe("columns", () => {
  const ids = (width: number, metric: MetricId) => buildColumns(width, metric).map((column) => column.id);

  test("the chosen metric and its 30 day change follow the chain, then the rest in growthepie's order", () => {
    expect(ids(110, "fees")).toEqual(["chain", "fees", "change", "txcount", "daa", "txcosts", "throughput", "stables", "tvs"]);
    expect(ids(110, "tvs")).toEqual(["chain", "tvs", "change", "txcount", "daa", "fees", "txcosts", "throughput", "stables"]);
  });

  test("a 90 column terminal keeps the pair and the most useful metrics", () => {
    // 88 columns: the pane inside a 90 column terminal.
    expect(ids(88, "txcount")).toEqual(["chain", "txcount", "change", "daa", "fees", "stables", "tvs"]);
    expect(ids(88, "throughput")).toEqual(["chain", "throughput", "change", "txcount", "daa", "fees", "tvs"]);
  });

  test("narrower panes drop metrics from the least useful end and never the chosen one", () => {
    expect(ids(60, "txcount")).toEqual(["chain", "txcount", "change", "daa", "fees"]);
    expect(ids(60, "throughput")).toEqual(["chain", "throughput", "change", "txcount", "fees"]);
    expect(ids(30, "tvs").slice(0, 3)).toEqual(["chain", "tvs", "change"]);
  });

  test("every layout fits the width it was built for", () => {
    for (const width of [40, 50, 60, 70, 80, 88, 100, 120]) {
      const columns = buildColumns(width, "fees");
      const used = columns.reduce((sum, column) => sum + Math.max(column.width, String(column.label).length + 2) + 1, 2);
      if (width >= 44) expect(used).toBeLessThanOrEqual(width - 1);
    }
  });
});

describe("sorting", () => {
  const order = (metric: MetricId, sort = defaultSort(metric)) => sortRows(rows, sort, metric).map((entry) => entry.id);

  test("defaults to the chosen metric, largest first, with chains that have none last", () => {
    expect(order("txcount")).toEqual(["base", "arbitrum", "ethereum", "zksync_era"]);
    expect(order("fees")).toEqual(["arbitrum", "zksync_era", "base", "ethereum"]);
  });

  test("ascending still keeps chains without a value at the end", () => {
    expect(order("fees", { columnId: "fees", direction: "asc" })).toEqual(["base", "zksync_era", "arbitrum", "ethereum"]);
  });

  test("the change column sorts the chosen metric's 30 day change, missing ones last", () => {
    expect(order("fees", { columnId: "change", direction: "desc" })).toEqual(["base", "zksync_era", "arbitrum", "ethereum"]);
    expect(order("txcount", { columnId: "change", direction: "asc" })).toEqual(["base", "ethereum", "arbitrum", "zksync_era"]);
  });

  test("the chain column sorts by name", () => {
    expect(order("txcount", { columnId: "chain", direction: "asc" })).toEqual(["arbitrum", "base", "ethereum", "zksync_era"]);
  });

  test("header clicks start numbers descending and names ascending, then flip", () => {
    expect(nextSort(defaultSort("txcount"), "fees")).toEqual({ columnId: "fees", direction: "desc" });
    expect(nextSort({ columnId: "fees", direction: "desc" }, "fees")).toEqual({ columnId: "fees", direction: "asc" });
    expect(nextSort(defaultSort("txcount"), "chain")).toEqual({ columnId: "chain", direction: "asc" });
  });
});

describe("naming a chain", () => {
  test("by growthepie's key, name or short name in any case, or a prefix of one", () => {
    expect(resolveChainId(rows, "zksync_era")).toBe("zksync_era");
    expect(resolveChainId(rows, "ZKsync Era")).toBe("zksync_era");
    expect(resolveChainId(rows, "zksync-era")).toBe("zksync_era");
    expect(resolveChainId(rows, "ethereum")).toBe("ethereum");
    expect(resolveChainId(rows, "arb")).toBe("arbitrum");
  });

  test("an unknown or empty name selects nothing", () => {
    expect(resolveChainId(rows, "solana")).toBeNull();
    expect(resolveChainId(rows, "  ")).toBeNull();
    expect(resolveChainId(rows, null)).toBeNull();
  });
});
