// burnrate: one source for the full mod and the two standalone ones.
// scripts/build.py writes plugins/<name>/hooks/register.tsx from this file,
// flipping FEATURES and the plugin name; edit here, then run the script.

import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Category, Snapshot, Tokens } from '../types'

const FEATURES = { band: true, guard: true }

// ---- band ----

const ZERO: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

const snap = atom({ plugin: 'burnrate', key: 'snap' } as const, null)
const lastTurn = atom({ plugin: 'burnrate', key: 'lastTurn' } as const, null)
const total = atom({ plugin: 'burnrate', key: 'total' } as const, ZERO)
const categories = atom({ plugin: 'burnrate', key: 'categories' } as const, [])
const isExpanded = atom({ plugin: 'burnrate', key: 'isExpanded' } as const, false)

// One accent for normal fill, two alarm tones; category hues for the context bar.
const ACCENT = '#d97757'
const WARN = '#d4a72c'
const DANGER = '#e5534b'
const TRACK = '#8a8a8a'
const HUES = ['#d97757', '#6c9ef8', '#57ab5a', '#b083f0', '#e0a84f', '#4fb3c4', '#c96198', '#8b949e']

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const fmt = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : `${n}`

const tone = (pct: number) => (pct >= 80 ? DANGER : pct >= 50 ? WARN : ACCENT)

const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

const svgMeter = (pct: number, w: number, h: number, fill: string) => {
  const r = h / 2
  const filled = pct > 0 ? Math.max(h, (Math.min(pct, 100) / 100) * w) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" rx="${r}" fill="${TRACK}" fill-opacity="0.22"/>` +
    (filled ? `<rect width="${filled.toFixed(1)}" height="${h}" rx="${r}" fill="${fill}"/>` : '') +
    `</svg>`
  )
}

const svgStack = (parts: { tokens: number; color: string }[], max: number, w: number, h: number) => {
  let x = 0
  const rects = parts
    .map(p => {
      const pw = (p.tokens / max) * w
      const rect = pw >= 1 ? `<rect x="${x.toFixed(1)}" width="${Math.max(1, pw - 1.5).toFixed(1)}" height="${h}" fill="${p.color}"/>` : ''
      x += pw
      return rect
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><clipPath id="c"><rect width="${w}" height="${h}" rx="${h / 2}"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><rect width="${w}" height="${h}" fill="${TRACK}" fill-opacity="0.22"/>${rects}</g>` +
    `</svg>`
  )
}

const toSnapshot = (u: Pick<SessionUsage, 'rateLimits' | 'context' | 'cost'>): Snapshot => ({
  limits: u.rateLimits,
  ctxTokens: u.context.tokens,
  ctxWindow: u.context.window,
  ctxPercent: u.context.percent,
  usd: u.cost?.usd,
})

async function refreshBreakdown($: Engine) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const rows: Category[] = (u.context.breakdown?.categories ?? [])
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
    await update($, categories, () => rows)
    await update($, snap, () => toSnapshot(u))
  } catch {
    // no session bound yet: keep the last figures
  }
}

// ---- guard ----

// The 5h window share at which the brake engages, unless `/guard <n>` stored another.
const DEFAULT_THRESHOLD = 85
// The weekly window brakes on its own near the very end.
const WEEKLY_THRESHOLD = 95
// Below the brake, a softer "be concise" nudge starts this many points earlier.
const SOFT_MARGIN = 15
// A turn that writes at least this much to the cache, more than it reads, lost its cache.
const CACHE_MISS_TOKENS = 20_000

const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'mcp__swarm__swarm_dispatch'])

// Shell commands that walk a whole tree.
const WIDE_SHELL =
  /\bfind\s+(\.|\/|~|[A-Za-z]:[\\/]?)(\s|$)|\bgrep\s+-[A-Za-z]*[rR]|\brg\s+--files\b|\bls\s+-[A-Za-z]*R|\btree\b|\bdu\s+-[A-Za-z]*a|Get-ChildItem\b[^|;]*-Recurse|\bdir\s+\/s\b/i

const ROOTISH = /^([A-Za-z]:[\\/]?|\/|~|\.|\.\/)$/

// Module state: starts over on a reload; the engine re-measures right away.
let limits: SessionRateLimit[] = []
let threshold = DEFAULT_THRESHOLD
let isOff = false
let turns = 0
let lastModel: string | undefined
let lastTurnAt = 0

const window = (kind: string) => limits.find(l => l.kind === kind)
const fiveHour = () => window('five_hour')?.percentUsed ?? 0
const weekly = () => window('seven_day')?.percentUsed ?? 0
const isBraked = () => !isOff && (fiveHour() >= threshold || weekly() >= WEEKLY_THRESHOLD)
const isSoft = () => !isOff && !isBraked() && fiveHour() >= threshold - SOFT_MARGIN

const why = () => (weekly() >= WEEKLY_THRESHOLD ? `недельный лимит на ${weekly()}%` : `лимит 5ч на ${fiveHour()}%`)

const deny = (what: string) => ({
  deny:
    `burnrate: ${why()} — ${what} отключены, чтобы не сжечь остаток. ` +
    'Сделай задачу сам и точечно (конкретный путь, конкретный файл, Read с offset/limit). ' +
    'Пользователь может снять блок командой /guard off.',
})

function showStatus($: Engine) {
  $.ui.status(isBraked() ? `🛑 burnrate: ${why()}` : isSoft() ? `burnrate: ${fiveHour()}%, коротко` : undefined)
}

// ---- hooks ----

async function guardStart($: Engine) {
  const stored = await $.store.get('threshold')
  if (typeof stored === 'number') threshold = stored
  $.command.register({ name: 'guard', description: 'burnrate guard: status, on, off, or a 5h threshold (e.g. /guard 90)', argumentHint: '[on|off|<percent>]' })
  limits = (await $.session.usage()).rateLimits
  showStatus($)
}

function guardMeasure($: Engine, rateLimits: SessionRateLimit[]) {
  const wasBraked = isBraked()
  limits = rateLimits
  if (!wasBraked && isBraked()) {
    $.ui.toast(`🛑 burnrate: ${why()}. Субагенты и широкие сканы заблокированы, ответы — коротко. /guard off чтобы снять.`)
  }
  showStatus($)
}

async function bandTurn($: Engine, t: Tokens) {
  await update($, lastTurn, () => t)
  await update($, total, prev => ({
    input: prev.input + t.input,
    cacheRead: prev.cacheRead + t.cacheRead,
    cacheWrite: prev.cacheWrite + t.cacheWrite,
    output: prev.output + t.output,
  }))
}

async function guardTurn($: Engine, t: Tokens, model: string) {
  const now = await $.clock.now()
  const gapMin = turns > 0 ? Math.round((now - lastTurnAt) / 60_000) : 0
  const isMiss = turns > 0 && t.cacheWrite >= CACHE_MISS_TOKENS && t.cacheWrite > t.cacheRead

  if (isMiss) {
    const cause =
      lastModel && lastModel !== model
        ? `сменилась модель (${lastModel} → ${model})`
        : gapMin >= 60
          ? `кэш протух: пауза ${gapMin} мин`
          : gapMin >= 5
            ? `пауза ${gapMin} мин — возможно, кэш на 5 мин истёк`
            : 'поменялся системный промпт или инструменты (CLAUDE.md, MCP, скиллы, плагины) либо был /compact'
    // Writing costs 1.25–2× input, reading 0.1×: a rewrite is roughly 12–20× a cached read.
    $.ui.toast(`⚠ Кэш сброшен: записано ${fmt(t.cacheWrite)}, прочитано ${fmt(t.cacheRead)} — ход ~в 12–20 раз дороже. Причина: ${cause}.`)
  }

  turns += 1
  lastModel = model
  lastTurnAt = now
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (FEATURES.band) await refreshBreakdown($)
    if (FEATURES.guard) await guardStart($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (FEATURES.band) {
      await update($, snap, () => toSnapshot(e))
      if (e.changed.includes('context')) await refreshBreakdown($)
    }
    if (FEATURES.guard) guardMeasure($, e.rateLimits)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u && !e.agentId) {
      const t: Tokens = {
        input: u.input_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        output: u.output_tokens,
      }
      if (FEATURES.band) await bandTurn($, t)
      if (FEATURES.guard) await guardTurn($, t, u.model)
    }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (!FEATURES.guard || e.command !== 'guard') return next(e)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') isOff = true
    else if (arg === 'on') isOff = false
    else if (/^\d{1,3}$/.test(arg)) {
      threshold = Math.min(100, Math.max(1, Number(arg)))
      await $.store.set('threshold', threshold)
    } else if (arg !== '') {
      return { text: 'Использование: /guard, /guard on, /guard off, /guard <процент>' }
    }
    showStatus($)
    const state = isOff ? 'выключен на эту сессию' : isBraked() ? `ТОРМОЗ (${why()})` : 'следит'
    return { text: `burnrate guard: ${state}. Порог 5ч: ${threshold}% (мягкий режим с ${threshold - SOFT_MARGIN}%). Сейчас 5ч ${fiveHour()}%, 7д ${weekly()}%.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!FEATURES.guard) return next(e)
    if (isBraked()) {
      const reset = untilReset(window('five_hour')?.resetsAt, await $.clock.now())
      return next({
        ...e,
        context: [
          ...(e.context ?? []),
          `[burnrate] ${why()}${reset && reset !== 'now' ? `, сброс через ${reset}` : ''}. Отвечай максимально коротко: без вступлений, пересказов и итогов — только суть и код. ` +
            'Не запускай субагентов и не сканируй проект целиком; читай только нужные куски файлов.',
        ],
      })
    }
    if (isSoft()) {
      return next({
        ...e,
        context: [...(e.context ?? []), `[burnrate] Лимит 5ч на ${fiveHour()}%. Будь лаконичен, не трать токены на лишнее.`],
      })
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!FEATURES.guard || !isBraked()) return next(e)
    if (SUBAGENT_TOOLS.has(e.tool)) return deny('субагенты')
    if (e.tool === 'Glob' && (!e.path || ROOTISH.test(e.path)) && /^\*\*/.test(e.pattern)) {
      return deny('широкие сканы (Glob по всему проекту)')
    }
    if (e.tool === 'Grep' && (!e.path || ROOTISH.test(e.path)) && !e.glob && !e.type) {
      return deny('широкие сканы (Grep без пути и фильтра)')
    }
    if ((e.tool === 'Bash' || e.tool === 'PowerShell') && WIDE_SHELL.test(e.command)) {
      return deny('рекурсивные обходы файлов в шелле')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (!FEATURES.band || e.props.hasSurvey || s === null) {
      return next(e)
    }

    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const now = await $.clock.now()
    const expanded = await read($, isExpanded)
    const turn = await read($, lastTurn)
    const sum = await read($, total)
    const cats = await read($, categories)

    // A meter: an SVG pill where the surface draws SVG, a thin text bar otherwise.
    const meter = (id: string, pct: number, color: string, width: number) => {
      if (Svg) {
        return <Svg key={`m-${id}`} source={svgMeter(pct, width, 6, color)} alt={`${Math.round(pct)}%`} width={width} height={6} />
      }
      const cells = Math.round(width / 8)
      const lit = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
      return (
        <Box key={`m-${id}`}>
          <Text color={color}>{'━'.repeat(lit)}</Text>
          <Text dimColor>{'━'.repeat(cells - lit)}</Text>
        </Box>
      )
    }

    const stat = (id: string, label: string, pct: number, value: string, hint: string, color: string) => (
      <Box key={id} alignItems="center" gap={1}>
        <Text dimColor>{label}</Text>
        {meter(id, pct, color, 72)}
        <Text bold color={pct >= 50 ? color : undefined}>
          {value}
        </Text>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
    )

    const limitStats = s.limits.map(l =>
      stat(`lim-${l.kind}`, LABEL[l.kind] ?? l.kind, l.percentUsed, `${l.percentUsed}%`, untilReset(l.resetsAt, now), tone(l.percentUsed)),
    )

    const ctxPct = s.ctxPercent ?? 0
    const ctxStat = stat(
      'ctx',
      'ctx',
      ctxPct,
      `${ctxPct}%`,
      s.ctxTokens !== undefined ? `${fmt(s.ctxTokens)}/${fmt(s.ctxWindow)}` : `—/${fmt(s.ctxWindow)}`,
      ctxPct >= 80 ? DANGER : ctxPct >= 60 ? WARN : '#6c9ef8',
    )

    const allIn = sum.input + sum.cacheRead + sum.cacheWrite
    const hit = allIn > 0 ? Math.round((sum.cacheRead / allIn) * 100) : null

    const header = (
      <Box key="head" alignItems="center" gap={3} flexWrap="wrap">
        {limitStats.length > 0 ? limitStats : <Text dimColor>limits appear after the first reply</Text>}
        {ctxStat}
        {hit !== null ? (
          <Box key="hit" gap={1}>
            <Text dimColor>cache</Text>
            <Text bold>{hit}%</Text>
          </Box>
        ) : null}
        {s.usd !== undefined ? <Text dimColor>${s.usd.toFixed(2)}</Text> : null}
        <Button key="toggle" label={expanded ? '▴' : '▾'} onPress={() => update($, isExpanded, v => !v)} />
      </Box>
    )

    if (!expanded) {
      return <Box flexDirection="column">{header}</Box>
    }

    const used = cats.reduce((a, c) => a + c.tokens, 0)
    const parts = cats.map((c, i) => ({ ...c, color: HUES[i % HUES.length] as string }))

    const composition =
      parts.length > 0 ? (
        <Box key="comp" flexDirection="column" gap={0} marginTop={1}>
          {Svg ? (
            <Svg key="stack" source={svgStack(parts, Math.max(used, 1), 480, 8)} alt="context composition" width={480} height={8} />
          ) : (
            <Box key="stack">
              {parts.map(p => (
                <Text key={`seg-${p.name}`} color={p.color}>
                  {'█'.repeat(Math.max(1, Math.round((p.tokens / Math.max(used, 1)) * 60)))}
                </Text>
              ))}
            </Box>
          )}
          <Box key="legend" gap={2} flexWrap="wrap">
            {parts.map(p => (
              <Box key={`lg-${p.name}`} gap={1}>
                <Text color={p.color}>●</Text>
                <Text dimColor>{p.name}</Text>
                <Text>{fmt(p.tokens)}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null

    const turnRow = turn ? (
      <Box key="turn" gap={2} flexWrap="wrap">
        <Text dimColor>last turn</Text>
        <Box key="t-read" gap={1}>
          <Text dimColor>cache read</Text>
          <Text>{fmt(turn.cacheRead)}</Text>
        </Box>
        <Box key="t-write" gap={1}>
          <Text dimColor>cache write</Text>
          <Text color={turn.cacheWrite > turn.cacheRead ? WARN : undefined}>{fmt(turn.cacheWrite)}</Text>
        </Box>
        <Box key="t-in" gap={1}>
          <Text dimColor>uncached</Text>
          <Text>{fmt(turn.input)}</Text>
        </Box>
        <Box key="t-out" gap={1}>
          <Text dimColor>output</Text>
          <Text>{fmt(turn.output)}</Text>
        </Box>
      </Box>
    ) : null

    return (
      <Box flexDirection="column">
        {header}
        {composition}
        {turnRow}
      </Box>
    )
  })
}
