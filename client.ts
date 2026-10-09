import { createThrottledFetch, httpFetch, type ThrottledFetchTransport } from "gloomberb/utils";
import type { MetricDef } from "./metrics";
import {
  parseFundamentalsPayload,
  parseHistoryPayload,
  parseMasterPayload,
} from "./normalize";
import type { FundamentalsData, HistoryData, MasterData } from "./types";

const BASE_URL = "https://api.growthepie.com/v1";

/** growthepie asks for at most 10 calls a minute. Staying below it leaves room for the retries the client counts too. */
export const REQUESTS_PER_MINUTE = 8;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
const RATE_LIMIT_MIN_WAIT_MS = 60_000;
const CHAIN_ID_PATTERN = /^[a-z0-9_]+$/;

export type GrowthepieErrorKind = "network" | "http" | "rate-limit" | "parse" | "backoff";

export class GrowthepieError extends Error {
  constructor(message: string, readonly kind: GrowthepieErrorKind, readonly retryAfterMs?: number) {
    super(message);
    this.name = "GrowthepieError";
  }
}

function seconds(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  return total >= 90 ? `${Math.ceil(total / 60)}m` : `${total}s`;
}

export interface GrowthepieClientOptions {
  transport?: ThrottledFetchTransport;
  requestsPerMinute?: number;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  now?: () => number;
}

export interface GrowthepieClient {
  fetchMaster(): Promise<MasterData>;
  fetchFundamentals(): Promise<FundamentalsData>;
  fetchHistory(chainId: string, metric: MetricDef): Promise<HistoryData>;
}

/**
 * The only code that talks to api.growthepie.com. Every call goes through one
 * throttle that holds the whole plugin to a few requests a minute, and each
 * endpoint backs off after a failure so a refresh timer cannot turn an outage
 * into a request storm: the first retry waits 30 seconds and each failure
 * after that doubles the wait, up to ten minutes. A 429 holds back every
 * endpoint for at least a minute, or for as long as `Retry-After` asks.
 */
export function createGrowthepieClient(options: GrowthepieClientOptions = {}): GrowthepieClient {
  const now = options.now ?? Date.now;
  const http = createThrottledFetch({
    requestsPerMinute: options.requestsPerMinute ?? REQUESTS_PER_MINUTE,
    maxRetries: options.maxRetries ?? 2,
    timeoutMs: options.timeoutMs ?? 15_000,
    backoffBaseMs: options.backoffBaseMs ?? 2_000,
    dedupeGetRequests: true,
    defaultHeaders: {
      Accept: "application/json",
      "User-Agent": "gloomberb-growthepie",
    },
    transport: options.transport ?? httpFetch,
  });

  const failures = new Map<string, { count: number; until: number }>();
  let rateLimitedUntil = 0;

  function assertOpen(key: string): void {
    const at = now();
    if (at < rateLimitedUntil) {
      throw new GrowthepieError(
        `Rate limited, next try in ${seconds(rateLimitedUntil - at)}.`,
        "backoff",
        rateLimitedUntil - at,
      );
    }
    const failure = failures.get(key);
    if (failure && at < failure.until) {
      throw new GrowthepieError(
        `Not answering, next try in ${seconds(failure.until - at)}.`,
        "backoff",
        failure.until - at,
      );
    }
  }

  function recordFailure(key: string): void {
    const count = (failures.get(key)?.count ?? 0) + 1;
    const wait = Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (count - 1));
    failures.set(key, { count, until: now() + wait });
  }

  async function getJson(key: string, path: string): Promise<unknown> {
    assertOpen(key);
    let response: Response;
    try {
      response = await http.fetch(`${BASE_URL}${path}`);
    } catch {
      recordFailure(key);
      throw new GrowthepieError("Can't reach growthepie.", "network");
    }
    if (response.status === 429) {
      const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const wait = Math.max(RATE_LIMIT_MIN_WAIT_MS, Number.isFinite(header) ? header * 1000 : 0);
      rateLimitedUntil = now() + wait;
      recordFailure(key);
      throw new GrowthepieError(`Rate limited, next try in ${seconds(wait)}.`, "rate-limit", wait);
    }
    if (!response.ok) {
      recordFailure(key);
      throw new GrowthepieError(`growthepie answered HTTP ${response.status}.`, "http");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      recordFailure(key);
      throw new GrowthepieError("growthepie sent data Gloom could not read.", "parse");
    }
    return body;
  }

  /** A payload that arrived but cannot be used counts as a failure too: asking again at once returns the same thing. */
  async function load<T>(key: string, path: string, parse: (body: unknown) => T): Promise<T> {
    const body = await getJson(key, path);
    try {
      const parsed = parse(body);
      failures.delete(key);
      return parsed;
    } catch (error) {
      recordFailure(key);
      throw new GrowthepieError(
        error instanceof Error && error.message ? error.message : "growthepie sent data Gloom could not read.",
        "parse",
      );
    }
  }

  return {
    fetchMaster: () => load("master", "/master.json", parseMasterPayload),
    fetchFundamentals: () => load("fundamentals", "/fundamentals.json", parseFundamentalsPayload),
    fetchHistory(chainId, metric) {
      if (!CHAIN_ID_PATTERN.test(chainId)) {
        return Promise.reject(new GrowthepieError("That chain has no growthepie history.", "parse"));
      }
      return load(
        `history:${chainId}:${metric.id}`,
        `/metrics/chains/${chainId}/${metric.apiId}.json`,
        (body) => parseHistoryPayload(body, metric),
      );
    },
  };
}

export const growthepieClient = createGrowthepieClient();

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "growthepie request failed.";
}
