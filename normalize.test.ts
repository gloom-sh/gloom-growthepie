import { describe, expect, test } from "bun:test";
import masterFixture from "./fixtures/master.json";
import fundamentalsFixture from "./fixtures/fundamentals.json";
import historyFees from "./fixtures/history-base-fees.json";
import historyTxcount from "./fixtures/history-base-txcount.json";
import { metricDef } from "./metrics";
import {
  buildDailySeries,
  buildRows,
  changeOver,
  filterRows,
  latestPoint,
  parseFundamentalsPayload,
  parseHistoryPayload,
  parseMasterPayload,
  seriesToPoints,
  sliceSeries,
} from "./normalize";
import type { DailySeries, FundamentalsData, MasterData } from "./types";

// The fixtures are real growthepie responses trimmed to a few chains and days.

function series(start: string, values: Array<number | null>): DailySeries {
  return { start, values };
}

describe("master.json", () => {
  test("keeps real chains, maps supported metrics and drops aggregates", () => {
    const master = parseMasterPayload(masterFixture);
    expect(master.chains.map((chain) => chain.id)).toEqual(["ethereum", "base", "arbitrum", "megaeth"]);
    const base = master.chains.find((chain) => chain.id === "base")!;
    expect(base.shortName).toBe("Base");
    expect(base.metrics).toEqual(["tvs", "txcount", "daa", "stables", "fees", "txcosts", "throughput"]);
    expect(master.chains.find((chain) => chain.id === "ethereum")!.metrics).not.toContain("tvs");
    expect(master.updatedUtc).toBe("2026-10-08 05:30:08");
  });

  test("leaves out chains growthepie marks DEV or ARCHIVED", () => {
    const master = parseMasterPayload({
      chains: {
        base: { name: "Base Chain", deployment: "PROD" },
        old: { name: "Old", deployment: "ARCHIVED" },
        wip: { name: "Wip", deployment: "dev" },
        flagged: { name: "Flagged", deployment_flag: "DEV" },
      },
    });
    expect(master.chains.map((chain) => chain.id)).toEqual(["base"]);
  });

  test("rejects a payload that is not a chain list", () => {
    expect(() => parseMasterPayload(null)).toThrow("unexpected chain list");
    expect(() => parseMasterPayload({ chains: [] })).toThrow("unexpected chain list");
    expect(() => parseMasterPayload({ chains: { all_l2s: { name: "All L2s" } } })).toThrow("no chains");
  });
});

describe("fundamentals.json", () => {
  const fundamentals = parseFundamentalsPayload(fundamentalsFixture);

  test("keeps the metrics the pane shows as dense daily series", () => {
    expect(Object.keys(fundamentals.series).sort()).toEqual(
      ["daa", "fees", "stables", "throughput", "tvs", "txcosts", "txcount"],
    );
    const base = fundamentals.series.txcount!.base!;
    expect(base.start).toBe("2026-09-05");
    expect(base.values).toHaveLength(33);
    expect(fundamentals.asOf).toBe("2026-10-07");
    // Ethereum has no total value secured in growthepie's data.
    expect(fundamentals.series.tvs!.ethereum).toBeUndefined();
  });

  test("skips rows it cannot trust and fills missing days with gaps", () => {
    const parsed = parseFundamentalsPayload([
      { metric_key: "txcount", origin_key: "base", date: "2026-01-01", value: 10 },
      { metric_key: "txcount", origin_key: "base", date: "2026-01-04", value: 40 },
      { metric_key: "txcount", origin_key: "base", date: "2026-01-05", value: null },
      { metric_key: "txcount", origin_key: "base", date: "not-a-date", value: 5 },
      { metric_key: "txcount", origin_key: "base", date: "2026-01-06", value: Number.NaN },
      { metric_key: "aa_last7d", origin_key: "base", date: "2026-01-04", value: 99 },
      "junk",
    ]);
    expect(parsed.series.txcount!.base).toEqual({ start: "2026-01-01", values: [10, null, null, 40] });
    expect(Object.keys(parsed.series)).toEqual(["txcount"]);
  });

  test("a payload with nothing usable is an error, never an empty table", () => {
    expect(() => parseFundamentalsPayload({})).toThrow("unexpected fundamentals");
    expect(() => parseFundamentalsPayload([])).toThrow("no data");
    expect(() => parseFundamentalsPayload([{ metric_key: "unknown", origin_key: "base", date: "2026-01-01", value: 1 }])).toThrow("no data");
  });
});

describe("30 day change", () => {
  test("matches the change growthepie publishes for its own daily series", () => {
    const fees = parseHistoryPayload(historyFees, metricDef("fees"));
    expect(changeOver(fees.series, 30)!).toBeCloseTo(historyFees.details.changes.daily["30d"]![0]!, 3);
    const txns = parseHistoryPayload(historyTxcount, metricDef("txcount"));
    expect(changeOver(txns.series, 30)!).toBeCloseTo(historyTxcount.details.changes.daily["30d"]![0]!, 3);
    // The pane's table gets the same figure from the 90 day export alone (the fixture rounds to six digits).
    const fundamentals = parseFundamentalsPayload(fundamentalsFixture);
    expect(changeOver(fundamentals.series.txcount!.base, 30)!).toBeCloseTo(changeOver(txns.series, 30)!, 5);
  });

  test("compares the latest observation with the day 30 days earlier", () => {
    const values = Array.from({ length: 40 }, (_, index) => 100 + index);
    expect(changeOver(series("2026-01-01", values), 30)).toBeCloseTo(139 / 109 - 1, 12);
  });

  test("is null when it cannot be computed honestly", () => {
    expect(changeOver(series("2026-01-01", [1, 2, 3]), 30)).toBeNull();
    expect(changeOver(undefined, 30)).toBeNull();
    const withGap = Array.from({ length: 31 }, (_, index) => index + 1) as Array<number | null>;
    withGap[0] = null;
    expect(changeOver(series("2026-01-01", withGap), 30)).toBeNull();
    const zeroBase = Array.from({ length: 31 }, () => 5) as Array<number | null>;
    zeroBase[0] = 0;
    expect(changeOver(series("2026-01-01", zeroBase), 30)).toBeNull();
    const negativeBase = Array.from({ length: 31 }, () => 5) as Array<number | null>;
    negativeBase[0] = -2;
    expect(changeOver(series("2026-01-01", negativeBase), 30)).toBeNull();
  });

  test("measures from the newest observation when the last days are empty", () => {
    const values = Array.from({ length: 40 }, (_, index) => index + 1) as Array<number | null>;
    values[38] = null;
    values[39] = null;
    expect(latestPoint(series("2026-01-01", values))).toEqual({ date: "2026-02-07", value: 38, index: 37 });
    expect(changeOver(series("2026-01-01", values), 30)).toBeCloseTo(38 / 8 - 1, 12);
  });
});

describe("rows", () => {
  const master = parseMasterPayload(masterFixture);
  const fundamentals = parseFundamentalsPayload(fundamentalsFixture);

  test("one row per chain with data, carrying value, date and change per metric", () => {
    const rows = buildRows(master, fundamentals);
    // Arbitrum is listed by growthepie but the trimmed export has nothing for it.
    expect(rows.map((row) => row.id)).toEqual(["ethereum", "base", "megaeth"]);
    const base = rows.find((row) => row.id === "base")!;
    expect(base.stats.txcount.value).toBeCloseTo(8275263, -2);
    expect(base.stats.txcount.date).toBe("2026-10-07");
    expect(base.stats.txcount.change30d).toBeCloseTo(-0.1445, 3);
    expect(base.stats.fees.change30d).toBeCloseTo(0.2375, 3);
    const ethereum = rows.find((row) => row.id === "ethereum")!;
    expect(ethereum.stats.tvs).toEqual({ value: null, date: null, change30d: null, stale: false });
  });

  test("a series that stopped days ago is stale and carries no change", () => {
    const stalledMaster: MasterData = { updatedUtc: null, chains: [
      { id: "live", name: "Live", shortName: "Live", chainType: "rollup", urlKey: "live", metrics: ["txcount"] },
      { id: "stalled", name: "Stalled", shortName: "Stalled", chainType: "rollup", urlKey: "stalled", metrics: ["txcount"] },
    ] };
    const data: FundamentalsData = {
      asOf: "2026-02-10",
      series: { txcount: {
        live: series("2026-01-01", Array.from({ length: 41 }, (_, index) => index + 10)),
        stalled: series("2026-01-01", Array.from({ length: 35 }, (_, index) => index + 10)),
      } },
    };
    const rows = buildRows(stalledMaster, data);
    expect(rows[0]!.stats.txcount.stale).toBe(false);
    expect(rows[0]!.stats.txcount.change30d).not.toBeNull();
    expect(rows[1]!.stats.txcount).toMatchObject({ stale: true, change30d: null, value: 44 });
  });

  test("search matches a chain by name, short name or key", () => {
    const rows = buildRows(master, fundamentals);
    expect(filterRows(rows, "eth").map((row) => row.id)).toEqual(["ethereum", "megaeth"]);
    expect(filterRows(rows, " BASE ").map((row) => row.id)).toEqual(["base"]);
    expect(filterRows(rows, "")).toHaveLength(3);
    expect(filterRows(rows, "zzz")).toEqual([]);
  });
});

describe("metric history", () => {
  test("reads the USD column of a currency metric and the value column of a count", () => {
    const fees = parseHistoryPayload(historyFees, metricDef("fees"));
    expect(latestPoint(fees.series)).toMatchObject({ date: "2026-10-07", value: 128245.34760329529 });
    const txns = parseHistoryPayload(historyTxcount, metricDef("txcount"));
    expect(latestPoint(txns.series)).toMatchObject({ date: "2026-10-07", value: 8275263 });
    expect(txns.series.values).toHaveLength(130);
    expect(txns.updatedUtc).toBe("2026-10-09 00:15:02");
  });

  test("an unexpected shape is an error the pane can show", () => {
    expect(() => parseHistoryPayload({}, metricDef("fees"))).toThrow("unexpected history");
    expect(() => parseHistoryPayload({ details: { timeseries: { daily: { types: ["unix"], data: [] } } } }, metricDef("fees"))).toThrow("unexpected history");
    expect(() => parseHistoryPayload({ details: { timeseries: { daily: { types: ["unix", "usd"], data: [[1, null]] } } } }, metricDef("fees"))).toThrow("no history");
  });
});

describe("series helpers", () => {
  test("slices the last days and keeps the start date in step", () => {
    const daily = series("2026-01-01", [1, 2, 3, 4, 5]);
    expect(sliceSeries(daily, 2)).toEqual({ start: "2026-01-04", values: [4, 5] });
    expect(sliceSeries(daily, 10)).toBe(daily);
    expect(sliceSeries(daily, null)).toBe(daily);
  });

  test("plot points keep gaps inside the series and cut empty days at the end", () => {
    const points = seriesToPoints(series("2026-01-01", [1, null, 3, null, null]));
    expect(points.map((point) => point.value)).toEqual([1, null, 3]);
    expect(points[2]!.date.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  test("a series spanning years of days is refused rather than allocated", () => {
    expect(buildDailySeries(new Map([["2000-01-01", 1], ["2026-01-01", 2]]))).toBeNull();
  });
});
