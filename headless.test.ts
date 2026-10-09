import { describe, expect, test } from "bun:test";
import type { HeadlessBundleSection, HeadlessPaneContext, HeadlessPaneLoadArgs } from "gloomberb/types/plugin";
import fundamentalsFixture from "./fixtures/fundamentals.json";
import historyFees from "./fixtures/history-base-fees.json";
import masterFixture from "./fixtures/master.json";
import { createGrowthepieHeadless, type GrowthepieHeadlessDependencies } from "./headless";
import { parseFundamentalsPayload, parseHistoryPayload, parseMasterPayload } from "./normalize";

const overview = {
  data: { master: parseMasterPayload(masterFixture), fundamentals: parseFundamentalsPayload(fundamentalsFixture) },
  fetchedAt: 1_760_000_000_000,
  masterFetchedAt: 1_760_000_000_000,
  stale: false,
  refreshError: null,
};

function dependencies(overrides: Partial<GrowthepieHeadlessDependencies> = {}): GrowthepieHeadlessDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async loadOverview(force) {
      calls.push(`overview:${force}`);
      return overview;
    },
    async loadHistory(chainId, metric) {
      calls.push(`history:${chainId}:${metric.id}`);
      return { data: parseHistoryPayload(historyFees, metric), fetchedAt: 1_760_000_000_000, stale: false, refreshError: null };
    },
    ...overrides,
  };
}

function args(argument: string | null, options: Record<string, string | number | boolean> = {}): HeadlessPaneLoadArgs {
  return { rawArgument: argument ?? "", argument, symbols: [], options: { metric: "txcount", range: "90d", ...options } };
}

const context = (refresh = false) => ({ refresh, signal: new AbortController().signal }) as unknown as HeadlessPaneContext;

function section(sections: HeadlessBundleSection[], title: string) {
  const found = sections.find((entry) => entry.title === title);
  if (!found) throw new Error(`no section ${title}`);
  return found;
}

describe("growthepie headless model", () => {
  test("ranks every chain by the chosen metric with the others beside it", async () => {
    const deps = dependencies();
    const result = await createGrowthepieHeadless(deps).load(args(null, { metric: "fees" }), context());
    const chains = section(result.sections, "Chains");
    expect(chains.rows!.map((row) => row.chainId)).toEqual(["ethereum", "base", "megaeth"]);
    expect(chains.rows![1]).toMatchObject({ chain: "Base", chainId: "base", date: "2026-10-07" });
    expect(chains.rows![1]!.change30d as number).toBeCloseTo(0.2375, 3);
    expect(chains.columns!.map((column) => column.header).slice(0, 3)).toEqual(["Chain", "Fees", "30D"]);
    // Raw numbers stay raw for JSON; the column formats them for text.
    const feesColumn = chains.columns![1]!;
    expect(feesColumn.format!(chains.rows![1]!.fees, chains.rows![1]!)).toBe("$128.2k");
    expect(deps.calls).toEqual(["overview:false"]);
  });

  test("always says where the data comes from and what Gloom computed", async () => {
    const result = await createGrowthepieHeadless(dependencies()).load(args(null), context());
    const source = section(result.sections, "Source");
    expect(source.entries!.map((entry) => entry.formatted)).toEqual([
      "growthepie, CC BY 4.0 (https://www.growthepie.com)",
      "Oct 7",
      "30D change computed by Gloom from growthepie's daily values",
    ]);
    expect(result.metadata).toMatchObject({ source: "growthepie, CC BY 4.0", asOf: "2026-10-07", metric: "txcount", stale: false });
  });

  test("a named chain adds its daily history over the chosen range", async () => {
    const deps = dependencies();
    const result = await createGrowthepieHeadless(deps).load(args("Base", { metric: "fees", range: "30d" }), context());
    const history = section(result.sections, "Base Fees paid");
    expect(history.rows).toHaveLength(30);
    expect(history.rows!.at(-1)).toMatchObject({ date: "2026-10-07" });
    // Thirty days sit inside the table's own payload, so no extra request.
    expect(deps.calls).toEqual(["overview:false"]);
    expect(result.complete).toBe(true);
  });

  test("a range beyond 90 days fetches that chain's history, once", async () => {
    const deps = dependencies();
    const result = await createGrowthepieHeadless(deps).load(args("base", { metric: "fees", range: "1y" }), context(true));
    expect(deps.calls).toEqual(["overview:true", "history:base:fees"]);
    expect(section(result.sections, "Base Fees paid").rows!.length).toBeGreaterThan(90);
  });

  test("a failed history request keeps the table and says so", async () => {
    const deps = dependencies({ async loadHistory() { throw new Error("Can't reach growthepie."); } });
    const result = await createGrowthepieHeadless(deps).load(args("base", { metric: "fees", range: "all" }), context());
    expect(result.complete).toBe(false);
    expect(result.errors![0]).toContain("Can't reach growthepie.");
    expect(section(result.sections, "Chains").rows!.length).toBe(3);
    expect(section(result.sections, "Base Fees paid").rows!.length).toBe(33);
  });

  test("an unknown chain is reported instead of silently ignored", async () => {
    const result = await createGrowthepieHeadless(dependencies()).load(args("solana"), context());
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual(['No chain matches "solana".']);
    expect(result.sections.map((entry) => entry.title)).toEqual(["Chains", "Source"]);
  });

  test("a chain without the metric says so", async () => {
    const result = await createGrowthepieHeadless(dependencies()).load(args("ethereum", { metric: "tvs" }), context());
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual(["growthepie has no total value secured for Ethereum L1."]);
  });

  test("a load failure surfaces as an error to the caller", async () => {
    const deps = dependencies({ async loadOverview() { throw new Error("growthepie answered HTTP 503."); } });
    await expect(createGrowthepieHeadless(deps).load(args(null), context())).rejects.toThrow("HTTP 503");
  });
});
