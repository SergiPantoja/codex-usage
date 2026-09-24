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

model           reqs        input       cached    output   cached     cost
──────────────────────────────────────────────────────────────────────────
gpt-6-astra      303   44,371,533   42,344,704   164,244    95.4%   $70.83
gpt-5.6-sol      145   24,386,440   22,684,544    99,354    93.0%   $17.87
gpt-5.6-terra     26    2,307,720    1,793,280    14,197    77.7%    $1.56
gpt-6-sol         31    2,803,517    2,634,496     6,884    94.0%    $0.93
gpt-5.6-luna      43    2,433,088    2,252,288    37,856    92.6%    $0.13
──────────────────────────────────────────────────────────────────────────
total            548   76,302,298   71,709,312   322,535    94.0%   $91.31
  compaction       4      895,413      893,824     9,766    99.8%    $1.03

month to date  $135.19      all time  $135.19

codex plan: plus · 5h window reset since · weekly window 33% used
  as of 2026-09-22 18:24

prices from LiteLLM, fetched 2026-09-23 23:26
checked 10 files · 1,154 requests · 0 duplicates · all 10 files reconcile
Fast mode is not logged (openai/codex#30413). It costs 2x the rates used here.

wrote codex-usage.md and codex-usage.svg
```

<!-- TODO after the first real run: generate examples/codex-usage.svg and embed it here.
     The sample above is real output from the author's own logs. -->

That is $91 of API-equivalent usage in one week on a $20 per month plan, with 94% of input
tokens served from cache.

## What it does

It reads `~/.codex/sessions/` and `~/.codex/archived_sessions/`, or the same two directories
under `CODEX_HOME` if you set it, which is where Codex writes them. It counts per-request token
usage. It reports a rolling window, month to date, and all time, and it shows your Codex rate-limit
windows as Codex last logged them, or says a window has reset since. It writes `codex-usage.md`
and `codex-usage.svg` to the current directory, or other names if you pass `--out`. The image
has the three period totals, a table of models, and a bar per day of the rolling window
stacked by model. When you run it in a terminal on your own machine, it opens the image. It
does not when output is piped, under `--json`, in CI, over SSH, or on Linux with no display.

## What it does not do

This is not your bill. Codex is a subscription. This number is what the same tokens would have
cost through the API, which is a different thing.

It never reads or transmits anything you typed. It skips conversation content and reads only
token counters. It never modifies anything under `~/.codex`.

## Usage

```
npx codex-usage-report [options]

  --out PREFIX    output prefix          (default: codex-usage)
  --days N        window, 1 to 365 days  (default: 7)
  --json          full aggregate to stdout, suppresses the table
  --offline       never touch the network, use bundled prices
  --help          this message
```

With `--json`, warnings and the names of the written files go to stderr, so stdout holds only
the JSON. The timezone comes from your system. It needs Node 22 or newer and has no dependencies.

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
which is a real request costing real money, so it appears in the totals. The line under the
total shows how much of it was compaction.

Cached input is already included in the input figure. Total is input plus output.

## Alternatives

If you want a usage dashboard across Claude Code, Codex, and Copilot, use
[ccusage](https://github.com/ccusage/ccusage). This is a smaller thing. One command, one
report, one image you can paste into a thread.

## Contributing

The most useful thing you can send is data about plans other than Plus. Everything here was
verified against a single Plus account.

One question worth answering if you have a Pro or Business account: is
`model_context_window` ever above 272,000? On Plus it is capped at 258,400 for every model,
which means long-context pricing at 2x input and 1.5x output can never trigger. If a higher
plan lifts that cap, the estimate changes a lot for anyone who raises it.

There is a probe script that prints only schema shape. No paths, no names, no conversation
content, safe to paste into an issue.

## License

MIT
