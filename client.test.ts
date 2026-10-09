import { describe, expect, test } from "bun:test";
import fundamentalsFixture from "./fixtures/fundamentals.json";
import historyFees from "./fixtures/history-base-fees.json";
import masterFixture from "./fixtures/master.json";
import { GrowthepieError, REQUESTS_PER_MINUTE, createGrowthepieClient } from "./client";
import { metricDef } from "./metrics";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function harness(responses: Array<Response | Error | ((url: string) => Response)>) {
  const calls: string[] = [];
  let clock = 1_000_000;
  const queue = [...responses];
  const client = createGrowthepieClient({
    transport: async (url) => {
      calls.push(url);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(url) : next.clone();
    },
    maxRetries: 0,
    backoffBaseMs: 1,
    now: () => clock,
  });
  return { client, calls, advance: (ms: number) => { clock += ms; } };
}

async function failure(promise: Promise<unknown>): Promise<GrowthepieError> {
  try {
    await promise;
  } catch (error) {
    return error as GrowthepieError;
  }
  throw new Error("expected the request to fail");
}

describe("growthepie client", () => {
  test("asks for the documented keyless endpoints only", async () => {
    const { client, calls } = harness([
      (url) => json(url.endsWith("master.json") ? masterFixture : url.endsWith("fundamentals.json") ? fundamentalsFixture : historyFees),
    ]);
    await client.fetchMaster();
    await client.fetchFundamentals();
    await client.fetchHistory("base", metricDef("fees"));
    await client.fetchHistory("zksync_era", metricDef("stables"));
    expect(calls).toEqual([
      "https://api.growthepie.com/v1/master.json",
      "https://api.growthepie.com/v1/fundamentals.json",
      "https://api.growthepie.com/v1/metrics/chains/base/fees.json",
      "https://api.growthepie.com/v1/metrics/chains/zksync_era/stables_mcap.json",
    ]);
  });

  test("holds the plugin below the documented limit of 10 calls a minute", () => {
    expect(REQUESTS_PER_MINUTE).toBeLessThan(10);
  });

  test("a chain key that is not a plain identifier never reaches the network", async () => {
    const { client, calls } = harness([json({})]);
    const error = await failure(client.fetchHistory("../master", metricDef("fees")));
    expect(error.kind).toBe("parse");
    expect(calls).toEqual([]);
  });

  test("a server error backs that endpoint off, doubling the wait each time", async () => {
    const { client, calls, advance } = harness([new Response("down", { status: 503 })]);
    const first = await failure(client.fetchMaster());
    expect(first).toMatchObject({ kind: "http", message: "growthepie answered HTTP 503." });
    // Inside the wait nothing is sent, and the message says how long is left.
    const blocked = await failure(client.fetchMaster());
    expect(blocked.kind).toBe("backoff");
    expect(blocked.message).toBe("growthepie is not answering. Next try in 30s.");
    expect(calls).toHaveLength(1);
    advance(30_000);
    await failure(client.fetchMaster());
    expect(calls).toHaveLength(2);
    advance(30_000);
    expect((await failure(client.fetchMaster())).message).toBe("growthepie is not answering. Next try in 30s.");
    advance(30_000);
    await failure(client.fetchMaster());
    expect(calls).toHaveLength(3);
  });

  test("one endpoint failing does not stop another", async () => {
    const { client } = harness([
      (url) => url.endsWith("fundamentals.json") ? new Response("no", { status: 500 }) : json(masterFixture),
    ]);
    await failure(client.fetchFundamentals());
    expect((await client.fetchMaster()).chains.length).toBeGreaterThan(0);
  });

  test("a success clears the back-off", async () => {
    const { client, advance } = harness([new Response("no", { status: 502 }), json(masterFixture)]);
    await failure(client.fetchMaster());
    advance(30_000);
    expect((await client.fetchMaster()).chains.length).toBeGreaterThan(0);
    expect((await client.fetchMaster()).chains.length).toBeGreaterThan(0);
  });

  test("a 429 holds back every endpoint for at least a minute, or as long as Retry-After says", async () => {
    const { client, calls, advance } = harness([
      new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    ]);
    const limited = await failure(client.fetchMaster());
    expect(limited).toMatchObject({ kind: "rate-limit", message: "growthepie is limiting requests. Next try in 2m." });
    const other = await failure(client.fetchFundamentals());
    expect(other.kind).toBe("backoff");
    expect(other.message).toBe("growthepie asked for fewer requests. Next try in 2m.");
    expect(calls).toHaveLength(1);
    advance(119_000);
    expect((await failure(client.fetchFundamentals())).kind).toBe("backoff");
    advance(2_000);
    await failure(client.fetchFundamentals());
    expect(calls).toHaveLength(2);
  });

  test("a 429 without Retry-After still waits a minute", async () => {
    const { client } = harness([new Response("slow down", { status: 429 })]);
    expect((await failure(client.fetchMaster())).message).toBe("growthepie is limiting requests. Next try in 60s.");
  });

  test("an unreachable network is reported plainly", async () => {
    const { client } = harness([new Error("fetch failed")]);
    expect(await failure(client.fetchMaster())).toMatchObject({ kind: "network", message: "Can't reach growthepie." });
  });

  test("a body that is not JSON, or not the expected shape, is a failure with its own message", async () => {
    const notJson = harness([new Response("<html>", { status: 200 })]);
    expect(await failure(notJson.client.fetchMaster())).toMatchObject({ kind: "parse", message: "growthepie sent data Gloom could not read." });
    const wrongShape = harness([json({ chains: [] })]);
    const error = await failure(wrongShape.client.fetchMaster());
    expect(error).toMatchObject({ kind: "parse", message: "growthepie returned an unexpected chain list" });
    // Asking again straight away would return the same thing, so it backs off too.
    expect((await failure(wrongShape.client.fetchMaster())).kind).toBe("backoff");
  });
});
