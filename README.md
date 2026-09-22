# codex-usage-report

What would your Codex usage have cost at API rates?

```bash
npx codex-usage-report
```

It reads your local Codex session logs, adds up the tokens, and prices them against public
OpenAI API rates. It writes a Markdown report and an SVG you can share. Nothing leaves your
machine except one request for the price table.

## Example

```
codex-usage-report · last 7 days · America/Havana

model             reqs         input        cached    output   cached     cost
─────────────────────────────────────────────────────────────────────────────
gpt-6-astra        303    44,371,533    42,344,704   164,244    95.4%   $70.83
gpt-5.6-sol        750    96,627,635    92,769,280   453,778    96.0%   $61.62
gpt-5.6-terra       26     2,307,720     1,793,280    14,197    77.7%    $1.56
gpt-5.6-luna        43     2,433,088     2,252,288    37,856    92.6%    $0.13
─────────────────────────────────────────────────────────────────────────────
total            1,123   145,969,117   139,388,288   672,013    95.5%  $134.13

month to date  $134.13      all time  $134.13

codex plan: plus · 5h window 1% used · weekly window 32% used

wrote codex-usage.md and codex-usage.svg
```

<!-- TODO after the first real run: generate examples/codex-usage.svg and embed it here.
     The sample above is real output from the author's own logs. -->

That is $134 of API-equivalent usage on a $20 per month plan, with 95.5% of input tokens
served from cache.

## What it does

It reads `~/.codex/sessions/` and `~/.codex/archived_sessions/`. It counts per-request token
usage. The logs also contain running totals, and adding those up inflates the numbers, so it
ignores them. It groups by exact model, so `gpt-5.6-sol` and `gpt-6-astra` never get merged.
It reports a rolling window, month to date, and all time, and it shows your Codex rate-limit
windows next to the cost. It writes `<prefix>.md` and `<prefix>.svg`, and opens the image if
you are on a terminal.

## What it does not do

This is not your bill. Codex is a subscription. This number is what the same tokens would have
cost through the API, which is a different thing.

It never reads or transmits anything you typed. It skips conversation content and reads only
token counters. It never modifies anything under `~/.codex`.

## Usage

```
npx codex-usage-report [options]

  --out PREFIX    output prefix          (default: codex-usage)
  --days N        rolling window length  (default: 7)
  --json          full aggregate to stdout, suppresses the table
  --offline       never touch the network, use bundled prices
  --help          this message
```

The timezone comes from your system. It needs Node 22 or newer and has no dependencies.

## What this sends over the network

It makes one unauthenticated GET request to `raw.githubusercontent.com` for the LiteLLM public
price table.

It sends no log contents, no file paths, no identifiers, and nothing about your account. The
URL is a fixed constant with nothing interpolated into it. Passing `--offline` skips the
request and uses the price table bundled with the package.

If the request fails for any reason, the report says so and names the prices it used instead.

## Accuracy

Fast mode is missing from the report. Codex requests the priority tier but the response comes
back recorded as `service_tier=default`, which is
[openai/codex#30413](https://github.com/openai/codex/issues/30413). Fast costs 2x standard
rates for every token type, so if you use it, your real API-equivalent cost is roughly double
what this shows. Every usage tracker reading these logs has the same problem.

Prices come from the LiteLLM public catalog, which mirrors OpenAI's published pricing page.
CI checks the two against each other daily. The report always names which price table it used
and when it was fetched.

Unknown models still count. A model with no published price keeps its token counts and shows
`N/A` for cost instead of being dropped.

Context compaction counts too. Codex periodically re-reads a conversation to summarise it,
which is a real request costing real money, so it appears in the totals.

Cached input is already included in the input figure. Total is input plus output.

## Alternatives

If you want a usage dashboard across Claude Code, Codex, and Copilot, use
[ccusage](https://github.com/ccusage/ccusage). This is a smaller thing. One command, one
report, one image you can paste into a thread.

## Contributing

The most useful thing you can send is data about plans other than Plus. Everything here was
verified against a single Plus account, so the rate-limit block, the available models, and the
context-window cap are all unverified elsewhere.

One question worth answering if you have a Pro or Business account: is
`model_context_window` ever above 272,000? On Plus it is capped at 258,400 for every model,
which means long-context pricing at 2x input and 1.5x output can never trigger. If a higher
plan lifts that cap, the estimate changes a lot for anyone who raises it.

There is a probe script that prints only schema shape. No paths, no names, no conversation
content, safe to paste into an issue.

## License

MIT
