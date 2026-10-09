import { createPluginCache } from "gloomberb/utils";
import type { PluginPersistence } from "gloomberb/types/plugin";
import { growthepieClient, type GrowthepieClient } from "./client";
import type { MetricDef } from "./metrics";
import type {
  FundamentalsData,
  GrowthepieOverview,
  HistoryData,
  MasterData,
} from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const SOURCE = "growthepie";
/** A manual refresh inside this window is answered from the cache, so `r` held down cannot become requests. */
const MIN_FORCED_REFRESH_MS = 15_000;

/*
 * growthepie rebuilds its daily exports once a day, early in the UTC morning,
 * so a few hours of freshness loses nothing. The long expiry is what keeps the
 * pane usable offline: the last good payload is shown, marked stale, while
 * refreshes back off.
 */
const masterCache = createPluginCache<MasterData>({
  kind: "master", source: SOURCE, schemaVersion: 1,
  policy: { staleMs: DAY_MS, expireMs: 30 * DAY_MS },
});
const fundamentalsCache = createPluginCache<FundamentalsData>({
  kind: "fundamentals", source: SOURCE, schemaVersion: 1,
  policy: { staleMs: 4 * HOUR_MS, expireMs: 14 * DAY_MS },
});
const historyCache = createPluginCache<HistoryData>({
  kind: "history", source: SOURCE, schemaVersion: 1,
  policy: { staleMs: 6 * HOUR_MS, expireMs: 30 * DAY_MS },
});

const OVERVIEW_KEY = "daily";

export function attachGrowthepiePersistence(persistence: PluginPersistence): void {
  masterCache.attach(persistence);
  fundamentalsCache.attach(persistence);
  historyCache.attach(persistence);
}

export function resetGrowthepiePersistence(): void {
  masterCache.reset();
  fundamentalsCache.reset();
  historyCache.reset();
  lastFetchAt.clear();
}

export interface CachedResult<T> {
  data: T;
  /** When this data was fetched from growthepie. */
  fetchedAt: number;
  /** A refresh failed, or the data is past its freshness window, so this is the last good copy. */
  stale: boolean;
  /** Why the latest refresh failed, when it did. */
  refreshError: string | null;
}

const lastFetchAt = new Map<string, number>();

function usableForce(key: string, force: boolean, now: number): boolean {
  if (!force) return false;
  const last = lastFetchAt.get(key);
  return last === undefined || now - last >= MIN_FORCED_REFRESH_MS;
}

async function loadThrough<T>(
  cache: ReturnType<typeof createPluginCache<T>>,
  kind: string,
  key: string,
  loader: () => Promise<T>,
  force: boolean,
  now: () => number,
): Promise<CachedResult<T>> {
  const attemptKey = `${kind}:${key}`;
  const result = await cache.load(key, () => {
    lastFetchAt.set(attemptKey, now());
    return loader();
  }, { force: usableForce(attemptKey, force, now()) });
  return {
    data: result.data,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}

export interface OverviewResult extends CachedResult<GrowthepieOverview> {
  /** Names and chain coverage change rarely; they were fetched at this time. */
  masterFetchedAt: number;
}

/**
 * The whole table: chain names and coverage (master.json, cached a day) and
 * 90 days of every metric for every chain (fundamentals.json, cached four
 * hours). Opening the pane with a warm cache makes no request at all.
 */
export async function loadOverview(
  force = false,
  client: GrowthepieClient = growthepieClient,
  now: () => number = Date.now,
): Promise<OverviewResult> {
  // Chain names move rarely, so a manual refresh only re-reads them when they are stale.
  const [master, fundamentals] = await Promise.all([
    loadThrough(masterCache, "master", OVERVIEW_KEY, () => client.fetchMaster(), false, now),
    loadThrough(fundamentalsCache, "fundamentals", OVERVIEW_KEY, () => client.fetchFundamentals(), force, now),
  ]);
  return {
    data: { master: master.data, fundamentals: fundamentals.data },
    fetchedAt: fundamentals.fetchedAt,
    masterFetchedAt: master.fetchedAt,
    stale: master.stale || fundamentals.stale,
    refreshError: fundamentals.refreshError ?? master.refreshError,
  };
}

export function getCachedOverview(): OverviewResult | null {
  const master = masterCache.get(OVERVIEW_KEY, { allowExpired: true });
  const fundamentals = fundamentalsCache.get(OVERVIEW_KEY, { allowExpired: true });
  if (!master || !fundamentals) return null;
  return {
    data: { master: master.data, fundamentals: fundamentals.data },
    fetchedAt: fundamentals.fetchedAt,
    masterFetchedAt: master.fetchedAt,
    stale: master.stale || fundamentals.stale,
    refreshError: null,
  };
}

function historyKey(chainId: string, metric: MetricDef): string {
  return `${chainId}:${metric.id}`;
}

/** One chain's full history for one metric, fetched only when a chart range needs more than the table holds. */
export function loadHistory(
  chainId: string,
  metric: MetricDef,
  force = false,
  client: GrowthepieClient = growthepieClient,
  now: () => number = Date.now,
): Promise<CachedResult<HistoryData>> {
  return loadThrough(historyCache, "history", historyKey(chainId, metric), () => client.fetchHistory(chainId, metric), force, now);
}

export function getCachedHistory(chainId: string, metric: MetricDef): CachedResult<HistoryData> | null {
  const cached = historyCache.get(historyKey(chainId, metric), { allowExpired: true });
  return cached
    ? { data: cached.data, fetchedAt: cached.fetchedAt, stale: cached.stale, refreshError: null }
    : null;
}
