# Codex usage report

Generated 2026-09-24 02:45 (America/New\_York) by codex-usage-report from the Codex session logs on this machine. Costs are what the same tokens would have cost at OpenAI API rates.

## Last 7 days

2026-09-18 to 2026-09-24

| Model | Requests | Input | Cached input | Output | Reasoning | Cached share | Cost |
|---|--:|--:|--:|--:|--:|--:|--:|
| gpt-6-astra | 406 | 35,373,023 | 33,741,440 | 144,059 | 15,546 | 95.4% | $57.26 |
| gpt-5.6-sol | 415 | 48,893,524 | 46,749,056 | 170,062 | 71,023 | 95.6% | $30.68 |
| gpt-5.6-terra | 36 | 2,242,358 | 1,746,816 | 10,147 | 3,851 | 77.9% | $1.46 |
| gpt-6-sol | 50 | 2,727,017 | 2,552,832 | 8,511 | 2,783 | 93.6% | $0.94 |
| gpt-5.6-luna | 24 | 2,130,366 | 1,988,864 | 19,979 | 7,349 | 93.4% | $0.09 |
| **Total** | **931** | **91,366,288** | **86,779,008** | **352,758** | **100,552** | **95.0%** | **$90.44** |

Compaction made 3 of these requests, with 657,990 input tokens and $0.49 of the cost.

## Month to date

2026-09-01 to 2026-09-24

| Model | Requests | Input | Cached input | Output | Reasoning | Cached share | Cost |
|---|--:|--:|--:|--:|--:|--:|--:|
| gpt-6-astra | 1,135 | 100,491,084 | 95,648,640 | 382,763 | 42,674 | 95.2% | $163.21 |
| gpt-5.6-sol | 1,684 | 195,879,700 | 187,513,984 | 738,404 | 310,344 | 95.7% | $123.24 |
| gpt-5.6-terra | 87 | 5,457,633 | 4,228,352 | 23,677 | 9,728 | 77.5% | $3.59 |
| gpt-6-sol | 50 | 2,727,017 | 2,552,832 | 8,511 | 2,783 | 93.6% | $0.94 |
| gpt-5.6-luna | 74 | 6,441,475 | 5,967,232 | 49,473 | 17,360 | 92.6% | $0.27 |
| **Total** | **3,030** | **310,996,909** | **295,911,040** | **1,202,828** | **382,889** | **95.1%** | **$291.25** |

Compaction made 13 of these requests, with 2,835,955 input tokens and $2.09 of the cost.

## All time

2026-08-24 to 2026-09-24

| Model | Requests | Input | Cached input | Output | Reasoning | Cached share | Cost |
|---|--:|--:|--:|--:|--:|--:|--:|
| gpt-6-astra | 1,305 | 114,960,386 | 109,446,656 | 445,523 | 49,267 | 95.2% | $186.86 |
| gpt-5.6-sol | 2,154 | 251,015,979 | 240,343,680 | 940,521 | 397,068 | 95.7% | $157.64 |
| gpt-5.6-terra | 104 | 6,662,786 | 5,201,152 | 27,598 | 11,188 | 78.1% | $4.29 |
| gpt-6-sol | 50 | 2,727,017 | 2,552,832 | 8,511 | 2,783 | 93.6% | $0.94 |
| gpt-5.6-luna | 100 | 8,699,687 | 8,070,400 | 63,016 | 22,436 | 92.8% | $0.36 |
| **Total** | **3,713** | **384,065,855** | **365,614,720** | **1,485,169** | **482,742** | **95.2%** | **$350.10** |

Compaction made 16 of these requests, with 3,489,692 input tokens and $2.57 of the cost.

## Rate limits

The latest snapshot Codex logged for each bucket, not a total for any period. Times are in America/New\_York.

| Bucket | Plan | Window | Used | Resets | As of |
|---|---|---|--:|---|---|
| codex | plus | 5h | 65% | 2026-09-24 05:05 | 2026-09-24 02:40 |
| codex | plus | weekly | 59% | 2026-09-29 09:45 | 2026-09-24 02:40 |
| premium | plus | none reported | | | 2026-09-24 01:07 |

## Prices

Prices come from the LiteLLM public price table, fetched 2026-09-24 02:45.

## Checks

- 111 files read, 3,713 requests counted, 0 duplicates skipped.
- All 111 files with usage reconcile, meaning the per-request usage adds up to Codex's own running total.
- 0 directories and 0 files could not be read. 0 malformed lines in the middle of a file, 0 at the end of one.
- 0 requests with no model, 0 with no readable timestamp, 0 with cache-write tokens.
- Usage fields missing: none.
- Models: gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-6-astra, gpt-6-sol.
- Codex versions: 0.154.0-alpha.6.2, 0.155.0-alpha.2.6. Clients: Codex Desktop, codex\_vscode. Session sources: \<object:subagent\>, vscode.
- Reasoning efforts: high, max, medium. Service tiers: default.

## Accuracy

- This is not a bill. Codex is a subscription, and these are the costs of the same tokens through the API.
- Fast mode is not visible in the logs ([openai/codex#30413](https://github.com/openai/codex/issues/30413)). Requests made in Fast mode cost 2x these rates.
- Cached input is priced at the cached rate, which assumes the API would have cached the same requests. OpenAI documents no difference in caching between subscription and API use.
- Cached input is part of input, and reasoning is part of output.

## Privacy

This report holds token counts, costs, model names, rate-limit percentages and Codex version strings. It holds no conversation text, no file paths, no thread names and no agent nicknames. For what the tool sends over the network, see [What this sends over the network](https://github.com/SergiPantoja/codex-usage#what-this-sends-over-the-network) in the README.
