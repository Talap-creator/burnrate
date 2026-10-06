import type { Engine, Register, SessionRateLimit } from 'claude-code'

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

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}ч ${m}м` : `${m}м`
}

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
    `limit-guard: ${why()} — ${what} отключены, чтобы не сжечь остаток. ` +
    'Сделай задачу сам и точечно (конкретный путь, конкретный файл, Read с offset/limit). ' +
    'Пользователь может снять блок командой /guard off.',
})

function showStatus($: Engine) {
  $.ui.status(isBraked() ? `🛑 guard: ${why()}` : isSoft() ? `guard: ${fiveHour()}%, коротко` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('threshold')
    if (typeof stored === 'number') threshold = stored
    $.command.register({ name: 'guard', description: 'limit-guard: status, on, off, or a 5h threshold (e.g. /guard 90)', argumentHint: '[on|off|<percent>]' })
    const u = await $.session.usage()
    limits = u.rateLimits
    showStatus($)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    const wasBraked = isBraked()
    limits = e.rateLimits
    if (!wasBraked && isBraked()) {
      $.ui.toast(`🛑 limit-guard: ${why()}. Субагенты и широкие сканы заблокированы, ответы — коротко. /guard off чтобы снять.`)
    }
    showStatus($)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'guard') return next(e)
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
    return { text: `limit-guard: ${state}. Порог 5ч: ${threshold}% (мягкий режим с ${threshold - SOFT_MARGIN}%). Сейчас 5ч ${fiveHour()}%, 7д ${weekly()}%.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isBraked()) {
      const reset = untilReset(window('five_hour')?.resetsAt, await $.clock.now())
      return next({
        ...e,
        context: [
          ...(e.context ?? []),
          `[limit-guard] ${why()}${reset ? `, сброс через ${reset}` : ''}. Отвечай максимально коротко: без вступлений, пересказов и итогов — только суть и код. ` +
            'Не запускай субагентов и не сканируй проект целиком; читай только нужные куски файлов.',
        ],
      })
    }
    if (isSoft()) {
      return next({
        ...e,
        context: [...(e.context ?? []), `[limit-guard] Лимит 5ч на ${fiveHour()}%. Будь лаконичен, не трать токены на лишнее.`],
      })
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!isBraked()) return next(e)
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

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (!u || e.agentId) return next(e)
    const now = await $.clock.now()
    const gapMin = turns > 0 ? Math.round((now - lastTurnAt) / 60_000) : 0
    const isMiss = turns > 0 && u.cache_creation_input_tokens >= CACHE_MISS_TOKENS && u.cache_creation_input_tokens > u.cache_read_input_tokens

    if (isMiss) {
      const cause =
        lastModel && lastModel !== u.model
          ? `сменилась модель (${lastModel} → ${u.model})`
          : gapMin >= 60
            ? `кэш протух: пауза ${gapMin} мин`
            : gapMin >= 5
              ? `пауза ${gapMin} мин — возможно, кэш на 5 мин истёк`
              : 'поменялся системный промпт или инструменты (CLAUDE.md, MCP, скиллы, плагины) либо был /compact'
      // Writing costs 1.25–2× input, reading 0.1×: a rewrite is roughly 12–20× a cached read.
      $.ui.toast(`⚠ Кэш сброшен: записано ${fmt(u.cache_creation_input_tokens)}, прочитано ${fmt(u.cache_read_input_tokens)} — ход ~в 12–20 раз дороже. Причина: ${cause}.`)
    }

    turns += 1
    lastModel = u.model
    lastTurnAt = now
    return next(e)
  })
}
