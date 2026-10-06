# claude-mods

Mods for Claude Code (terminal and desktop Code tab).

## Install

```
/plugin marketplace add Talap-creator/claude-mods
/plugin install limits-band@claude-mods
/plugin install limit-guard@claude-mods
/reload-plugins
```

## limits-band

A band above the prompt:

- **5h / 7d** subscription limits as meters, with time until reset (amber at 50%, red at 80%)
- **ctx**: how full the context window is
- **cache**: session prompt-cache hit rate, plus cost so far
- **▾ details**: a stacked bar of what fills the context (messages, system tools, MCP tools, system prompt, memory files, skills) and the last turn's split: cache read, cache write, uncached input, output. Cache write is highlighted when it beats cache read — the cache was invalidated and you paid full price.

Limits show up after the first reply of a session (they arrive with API responses) and only on a Claude.ai subscription.

## limit-guard

Keeps you from burning the rest of your plan.

- **Cache watchdog**: a toast when a turn rewrites the prompt cache instead of reading it (~12–20× the cost of a cached turn), with the likely cause: model switch, idle past the cache TTL, or a changed system prompt / tools / CLAUDE.md / `/compact`.
- **Soft mode** (5h ≥ threshold − 15%): Claude is told, out of sight, to be concise.
- **Brake** (5h ≥ threshold, default 85%, or 7d ≥ 95%):
  - subagents (`Agent`, swarm dispatch) are denied;
  - wide scans are denied: `Glob **/…` with no path, `Grep` with no path or filter, `find .`, `grep -r`, `ls -R`, `tree`, `Get-ChildItem -Recurse`;
  - every prompt carries a hidden "answer as short as possible" note. It rides as context, not as a system-prompt change, so it does not invalidate the cache.
- `/guard` shows status, `/guard off` / `/guard on` toggles it for the session, `/guard 90` sets the threshold (remembered).
