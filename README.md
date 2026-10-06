# claude-mods

Mods for Claude Code (terminal and desktop Code tab).

## Install

```
/plugin marketplace add Talap-creator/claude-mods
/plugin install limits-band@claude-mods
/reload-plugins
```

## limits-band

A band above the prompt:

- **5h / 7d** subscription limits as meters, with time until reset (amber at 50%, red at 80%)
- **ctx**: how full the context window is
- **cache**: session prompt-cache hit rate, plus cost so far
- **▾ details**: a stacked bar of what fills the context (messages, system tools, MCP tools, system prompt, memory files, skills) and the last turn's split: cache read, cache write, uncached input, output. Cache write is highlighted when it beats cache read — the cache was invalidated and you paid full price.

Limits show up after the first reply of a session (they arrive with API responses) and only on a Claude.ai subscription.
