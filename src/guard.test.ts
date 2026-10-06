import { expect, mock, test } from 'claude-code/testing'

const at = (five: number) => ({
  context: { window: 200000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: '2099-01-01T01:00:00Z' },
    { kind: 'seven_day', percentUsed: 10 },
  ],
  changed: ['rateLimits' as const],
})

const turn = (usage: { r: number; w: number; model?: string }) =>
  ({
    answer: 'ok',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: usage.r, cache_creation_input_tokens: usage.w, model: usage.model ?? 'm' },
  }) as never

test('brakes near the 5h cap: subagents and wide scans denied, short answers asked', async ($, on) => {
  mock.clock(on, { now: Date.parse('2099-01-01T00:00:00Z') })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(String((e as { text: string }).text)), {}) as never)
  on('ui.status', () => ({}) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))

  await $.session.measure(at(40))
  const relaxed = await $.prompt.submit({ text: 'hi', wait: false, origin: 'user' } as never)
  expect(relaxed.context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)).deny).toBeUndefined()

  await $.session.measure(at(90))
  expect(toasts.some(t => t.includes('лимит 5ч на 90%'))).toBe(true)

  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)).deny).toMatch(/субагенты/)
  expect((await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' } as never)).deny).toMatch(/Glob/)
  expect((await $.tool.call({ tool: 'Glob', pattern: '*.ts', path: 'src' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Grep', pattern: 'foo' } as never)).deny).toMatch(/Grep/)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'foo', path: 'src/app.ts' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'find . -name "*.ts"' } as never)).deny).toMatch(/шелле/)
  expect((await $.tool.call({ tool: 'Bash', command: 'git status' } as never)).deny).toBeUndefined()

  const braked = await $.prompt.submit({ text: 'hi', wait: false, origin: 'user' } as never)
  expect(braked.context?.[0]).toMatch(/коротко.*сброс через 1h 0m|сброс через 1h 0m.*коротко/s)

  await $.session.measure(at(75))
  const soft = await $.prompt.submit({ text: 'hi', wait: false, origin: 'user' } as never)
  expect(soft.context?.[0]).toMatch(/лаконичен/)
})

test('warns when a turn rewrites the cache instead of reading it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(String((e as { text: string }).text)), {}) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))

  await $.turn.complete(turn({ r: 0, w: 60000 }))
  await $.turn.complete(turn({ r: 60000, w: 2000 }))
  expect(toasts).toHaveLength(0)

  await $.turn.complete(turn({ r: 0, w: 62000, model: 'other' }))
  expect(toasts[0]).toMatch(/Кэш сброшен.*сменилась модель/)

  await clock.advance(90 * 60_000)
  await $.turn.complete(turn({ r: 0, w: 63000, model: 'other' }))
  expect(toasts[1]).toMatch(/протух: пауза 90 мин/)
})
