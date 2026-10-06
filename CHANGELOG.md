# Changelog

## 0.1.0 — 2026-10-06

First release.

- **burnrate**: the full mod, band and guard together.
- **limits-band**: band above the prompt with 5h/7d limit meters and reset timers, context fill, session cache hit rate and cost; expands into a stacked bar of what fills the context and the last turn's cache read / write / uncached / output split. SVG meters on desktop, thin bars in the terminal.
- **limit-guard**: toast when a turn rewrites the prompt cache, with the likely cause; soft "be concise" mode 15 points before the threshold; at the threshold (85% of 5h by default, or 95% of 7d) blocks subagents and wide scans and asks for short answers; `/guard` command.
