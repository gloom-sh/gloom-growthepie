import { describe, expect, test } from "bun:test";
import { formatMetricAxis } from "./axis";
import { formatChange, formatMetricValue, formatShortDate, rangeNeedsHistory } from "./metrics";

describe("metric formatting", () => {
  test("counts are written out while small, compact after that", () => {
    expect(formatMetricValue("daa", 1954)).toBe("1,954");
    expect(formatMetricValue("txcount", 8_275_263)).toBe("8.28M");
    expect(formatMetricValue("txcount", 356_221)).toBe("356.2k");
  });

  test("money uses compact dollars, and whole dollars while small", () => {
    expect(formatMetricValue("fees", 128_245.35)).toBe("$128.2k");
    expect(formatMetricValue("fees", 2_477.2)).toBe("$2,477");
    expect(formatMetricValue("stables", 163_585_308_903)).toBe("$163.59B");
    expect(formatMetricValue("tvs", 16_231_461_197)).toBe("$16.23B");
  });

  test("a transaction cost keeps the decimals that tell chains apart", () => {
    expect(formatMetricValue("txcosts", 0.117)).toBe("$0.117");
    expect(formatMetricValue("txcosts", 0.00179)).toBe("$0.0018");
    expect(formatMetricValue("txcosts", 2.4)).toBe("$2.40");
    expect(formatMetricValue("txcosts", 0.00003)).toBe("<$0.0001");
  });

  test("throughput is Mgas/s to two decimals, and a tiny negative is not a loss", () => {
    expect(formatMetricValue("throughput", 19.574)).toBe("19.57");
    expect(formatMetricValue("throughput", -0.0004)).toBe("0.00");
  });

  test("a missing value is a dash", () => {
    expect(formatMetricValue("fees", null)).toBe("--");
    expect(formatMetricValue("fees", Number.NaN)).toBe("--");
  });

  test("changes are signed percentages and stay short for huge moves", () => {
    expect(formatChange(-0.14450429)).toBe("-14.45%");
    expect(formatChange(0.2375)).toBe("+23.75%");
    expect(formatChange(3.3113)).toBe("+331.13%");
    expect(formatChange(12.5)).toBe("+1.3k%");
    expect(formatChange(null)).toBe("--");
  });

  test("dates read as month and day", () => {
    expect(formatShortDate("2026-10-07")).toBe("Oct 7");
    expect(formatShortDate(null)).toBe("--");
  });

  test("only ranges beyond the table's 90 days need a chain's full history", () => {
    expect(["30d", "90d", "1y", "all"].map((range) => rangeNeedsHistory(range as "30d"))).toEqual([false, false, true, true]);
  });
});

describe("chart axis", () => {
  const labels = (metric: "fees" | "txcount" | "txcosts" | "throughput", min: number, max: number, ticks: number[]) => (
    ticks.map((tick) => formatMetricAxis(metric, tick, { min, max }))
  );

  test("one unit across the whole axis, with the decimals the range needs", () => {
    expect(labels("fees", 0, 1_500_000, [0, 500_000, 1_000_000, 1_500_000])).toEqual(["$0", "$0.5M", "$1.0M", "$1.5M"]);
    expect(labels("txcount", 8_270_000, 8_290_000, [8_270_000, 8_280_000, 8_290_000])).toEqual(["8.270M", "8.280M", "8.290M"]);
    expect(labels("txcount", 4_600_000, 14_100_000, [4_600_000, 9_400_000, 14_100_000])).toEqual(["4.6M", "9.4M", "14.1M"]);
  });

  test("small fees keep distinct neighbouring ticks", () => {
    const ticks = labels("txcosts", 0.0010, 0.0026, [0.0010, 0.0018, 0.0026]);
    expect(new Set(ticks).size).toBe(3);
  });

  test("throughput follows the span", () => {
    expect(labels("throughput", 2.4, 2.6, [2.4, 2.5, 2.6])).toEqual(["2.40", "2.50", "2.60"]);
    expect(labels("throughput", 0, 40, [0, 20, 40])).toEqual(["0", "20", "40"]);
  });
});
