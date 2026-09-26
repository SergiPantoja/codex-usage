# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-09-26

### Added

- A warning when log files hold token usage that Codex 0.152 and earlier logged only as
  running totals, which this tool cannot count. It gives the number of files, and it covers
  threads started on an older Codex and resumed on a newer one. `--json` has the count as
  `meta.filesWithUncountedUsage`.

### Changed

- When no log file has a usage record and some hold usage from Codex 0.152 or earlier, the
  message says so instead of suggesting that Codex changed its log format.

## [0.1.0] - 2026-09-25

### Added

- Reads the Codex session logs in `~/.codex/sessions` and `~/.codex/archived_sessions`, or
  the same two directories under `CODEX_HOME`, and adds up the token usage of every request.
- Prices that usage at OpenAI API rates from the LiteLLM public price table, and falls back
  to a table bundled with the package when `--offline` is passed or the download fails.
- A terminal report for the last N days (`--days`, 1 to 365, default 7), month to date and
  all time, with each model's requests, tokens, cached share and cost, and the Codex
  rate-limit windows as last logged.
- `codex-usage.md`, the full report, and `codex-usage.svg`, a card with a stacked bar per
  day, written on every run (`--out` changes the names). The image opens when the tool runs
  in a terminal on your own machine.
- `--json`, which writes the whole report to stdout.
- A check that each log file's per-request usage adds up to Codex's own running total, and
  warnings when files cannot be read, when the logs do not match the expected format, or
  when a model has no published price.

[Unreleased]: https://github.com/SergiPantoja/codex-usage/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SergiPantoja/codex-usage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SergiPantoja/codex-usage/releases/tag/v0.1.0
