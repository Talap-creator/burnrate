import { atom, read, update } from 'claude-code'
import type { Engine, Register, SessionUsage } from 'claude-code'

import type { Category, Snapshot, Tokens } from '../types'

const ZERO: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

const snap = atom({ plugin: 'limits-band', key: 'snap' } as const, null)
const lastTurn = atom({ plugin: 'limits-band', key: 'lastTurn' } as const, null)
const total = atom({ plugin: 'limits-band', key: 'total' } as const, ZERO)
const categories = atom({ plugin: 'limits-band', key: 'categories' } as const, [])
const isExpanded = atom({ plugin: 'limits-band', key: 'isExpanded' } as const, false)

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshBreakdown($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, snap, () => toSnapshot(e))
    if (e.changed.includes('context')) {
      await refreshBreakdown($)
    }
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
      await update($, lastTurn, () => t)
      await update($, total, prev => ({
        input: prev.input + t.input,
        cacheRead: prev.cacheRead + t.cacheRead,
        cacheWrite: prev.cacheWrite + t.cacheWrite,
        output: prev.output + t.output,
      }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null) {
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
