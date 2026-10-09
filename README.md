# Layer 2 Metrics from growthepie

Ethereum and Layer 2 chains side by side: transactions, active addresses, fees, transaction cost, throughput, stablecoin supply and total value secured, with a 30 day change for the metric you pick and a daily history chart for the selected chain.

This is an independent plugin. It is not made, reviewed or endorsed by growthepie.

## Install

Requires Gloom 0.15.3 or newer.

```sh
gloomberb install gloom-sh/gloom-growthepie
```

Open `GTP` in the command bar, or `GTP base` to open it on one chain. It works in the terminal and the desktop app. It also declares the web target and its one API host, `api.growthepie.com`, so the hosted web app can bundle it and proxy the requests.

## Usage

`h`/`l` or the arrow keys switch the metric: the table ranks by it, the 30D column follows it, and the chart draws it. `j`/`k` or the arrow keys pick a chain, and the chart follows. Type `/` to search chains. The pane menu (`.`) has the chart range: 30D and 90D come with the table, 1Y and All load that one chain's history when you ask for them. `o` opens growthepie, `r` refreshes.

On the command line:

```sh
gloomberb fn GTP                                  # every chain, ranked by transactions
gloomberb fn GTP base --metric fees --range 1y    # plus Base's daily fees for a year
gloomberb shot GTP base --metric fees --watermark "Source: growthepie, CC BY 4.0"
```

| Metric | Tab | growthepie series |
| --- | --- | --- |
| Transactions | Txns | `txcount` |
| Active addresses | Addresses | `daa` |
| Fees paid | Fees | `fees_paid_usd` |
| Median transaction cost | Tx cost | `txcosts_median_usd` |
| Throughput (Mgas/s) | Throughput | `gas_per_second` |
| Stablecoin supply | Stables | `stables_mcap` |
| Total value secured | TVS | `tvl` |

All values are daily and in USD where they are money, up to the newest UTC day growthepie has published. Not every chain has every metric; a chain without one shows `--`.

## Data

Data is from [growthepie](https://www.growthepie.com) (orbal GmbH), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) under growthepie's [Data and API terms](https://docs.growthepie.com/methodology-caveats/methodology-and-caveats/usage-rules-and-data-tiers).

Source: growthepie, https://www.growthepie.com

The pane footer carries the same credit, and `o` opens growthepie.

What Gloom changes or computes:

- The 30D change is computed by Gloom. It compares the latest daily value with the value 30 days earlier, the same comparison growthepie publishes as `changes.daily.30d` in its metric detail. It is left empty when either day is missing or the earlier value is not above zero, and for a series that stopped more than two days before the others.
- Chains are the ones growthepie lists in `master.json`, without its aggregate entries (`all_l2s`, `multiple`) and without chains it marks `DEV` or `ARCHIVED`.
- Rankings, sorting, number formatting and charts are Gloom's.

How it reaches the API, which is public and needs no key:

| Request | When | Cached |
| --- | --- | --- |
| `v1/master.json` | opening the pane | 1 day |
| `v1/fundamentals.json` | opening the pane | 4 hours |
| `v1/metrics/chains/{chain}/{metric}.json` | choosing the 1Y or All range for a chain, once its selection rests | 6 hours |

growthepie asks for at most 10 calls a minute. The plugin sends at most 8, retries included. Opening the pane with a warm cache makes no request. After a failure each endpoint waits 30 seconds before the next try, doubling up to ten minutes, and a 429 holds every endpoint back for at least a minute. The last good data stays on screen, marked stale, while that happens. Nothing goes through Gloom Cloud.

## Development

```sh
bun install
# Link a Gloom checkout, as the plugin installer does:
ln -s /path/to/gloomberb node_modules/gloomberb
ln -s /path/to/gloomberb/node_modules/react node_modules/react
bun run typecheck
bun test
```

`gloomberb` and `react` are peer dependencies, never real ones. Gloom symlinks its own copies into every plugin directory on install and on load, so there is exactly one instance of each in the process. CI links the host the same way.

The tests read small trimmed copies of real growthepie responses in `fixtures/` and never touch the network.

## License

MIT. The data is not part of this license; see Data.
