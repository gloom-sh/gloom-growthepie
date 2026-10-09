import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import fundamentalsFixture from "./fixtures/fundamentals.json";
import historyFees from "./fixtures/history-base-fees.json";
import masterFixture from "./fixtures/master.json";
import { getCachedHistory, getCachedOverview, loadHistory, loadOverview, resetGrowthepiePersistence } from "./cache";
import { GrowthepieError, type GrowthepieClient } from "./client";
import { metricDef } from "./metrics";
import { parseFundamentalsPayload, parseHistoryPayload, parseMasterPayload } from "./normalize";

const HOUR = 3_600_000;

function fakeClient(overrides: Partial<GrowthepieClient> = {}) {
  const calls = { master: 0, fundamentals: 0, history: 0 };
  const client: GrowthepieClient = {
    async fetchMaster() {
      calls.master += 1;
      return parseMasterPayload(masterFixture);
    },
    async fetchFundamentals() {
      calls.fundamentals += 1;
      return parseFundamentalsPayload(fundamentalsFixture);
    },
    async fetchHistory(_chainId, metric) {
      calls.history += 1;
      return parseHistoryPayload(historyFees, metric);
    },
    ...overrides,
  };
  return { client, calls };
}

const START = new Date("2026-10-09T08:00:00Z");

beforeEach(() => {
  resetGrowthepiePersistence();
  setSystemTime(START);
});

afterEach(() => {
  setSystemTime();
  resetGrowthepiePersistence();
});

describe("overview cache", () => {
  test("a warm cache answers without a request", async () => {
    const { client, calls } = fakeClient();
    expect(getCachedOverview()).toBeNull();
    await loadOverview(false, client);
    setSystemTime(new Date(START.getTime() + HOUR));
    const again = await loadOverview(false, client);
    expect(calls).toEqual({ master: 1, fundamentals: 1, history: 0 });
    expect(again.stale).toBe(false);
    expect(getCachedOverview()?.data.fundamentals.asOf).toBe("2026-10-07");
  });

  test("the daily export is fetched again once it is past four hours, the chain list only after a day", async () => {
    const { client, calls } = fakeClient();
    await loadOverview(false, client);
    setSystemTime(new Date(START.getTime() + 5 * HOUR));
    await loadOverview(false, client);
    expect(calls).toMatchObject({ master: 1, fundamentals: 2 });
    setSystemTime(new Date(START.getTime() + 25 * HOUR));
    await loadOverview(false, client);
    expect(calls).toMatchObject({ master: 2, fundamentals: 3 });
  });

  test("a manual refresh re-reads the export but not the chain list, and not twice in a row", async () => {
    const { client, calls } = fakeClient();
    let clock = 1_000_000;
    const now = () => clock;
    await loadOverview(false, client, now);
    clock += 20_000;
    await loadOverview(true, client, now);
    expect(calls).toMatchObject({ master: 1, fundamentals: 2 });
    // Held down, the refresh key is answered from the cache.
    clock += 5_000;
    await loadOverview(true, client, now);
    expect(calls).toMatchObject({ master: 1, fundamentals: 2 });
    clock += 15_000;
    await loadOverview(true, client, now);
    expect(calls).toMatchObject({ master: 1, fundamentals: 3 });
  });

  test("when a refresh fails the last good payload is kept and marked stale with the reason", async () => {
    const healthy = fakeClient();
    await loadOverview(false, healthy.client);
    setSystemTime(new Date(START.getTime() + 5 * HOUR));
    const failing = fakeClient({
      async fetchFundamentals() {
        throw new GrowthepieError("Can't reach growthepie.", "network");
      },
    });
    const result = await loadOverview(false, failing.client);
    expect(result.stale).toBe(true);
    expect(result.refreshError).toBe("Can't reach growthepie.");
    expect(result.data.fundamentals.asOf).toBe("2026-10-07");
  });

  test("with nothing cached a failure is an error the pane shows", async () => {
    const failing = fakeClient({
      async fetchFundamentals() {
        throw new GrowthepieError("growthepie answered HTTP 503.", "http");
      },
    });
    await expect(loadOverview(false, failing.client)).rejects.toThrow("growthepie answered HTTP 503.");
    expect(getCachedOverview()).toBeNull();
  });
});

describe("history cache", () => {
  test("one request per chain and metric, then served from the cache", async () => {
    const { client, calls } = fakeClient();
    const fees = metricDef("fees");
    expect(getCachedHistory("base", fees)).toBeNull();
    const first = await loadHistory("base", fees, false, client);
    await loadHistory("base", fees, false, client);
    await loadHistory("base", metricDef("txcount"), false, client);
    expect(calls.history).toBe(2);
    expect(first.data.series.values.length).toBeGreaterThan(100);
    expect(getCachedHistory("base", fees)?.stale).toBe(false);
  });

  test("a failed history request leaves any earlier copy in place", async () => {
    const { client } = fakeClient();
    const fees = metricDef("fees");
    await loadHistory("base", fees, false, client);
    setSystemTime(new Date(START.getTime() + 7 * HOUR));
    const failing = fakeClient({ async fetchHistory() { throw new GrowthepieError("Can't reach growthepie.", "network"); } });
    const result = await loadHistory("base", fees, false, failing.client);
    expect(result).toMatchObject({ stale: true, refreshError: "Can't reach growthepie." });
  });
});
