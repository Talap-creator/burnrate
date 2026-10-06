import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
} as unknown as RenderPropsOf['AbovePrompt']

const LIMITS = [
  { kind: 'five_hour', percentUsed: 13, resetsAt: '2099-01-01T00:00:00Z' },
  { kind: 'seven_day', percentUsed: 85 },
]

test('band shows limits, turn cache split and context categories', async ($, on) => {
  mock.clock(on, { now: Date.parse('2098-12-31T21:30:00Z') })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: {
      window: 200000,
      tokens: 50000,
      percent: 25,
      breakdown: {
        categories: [
          { name: 'System prompt', tokens: 3000, color: 'x', isDeferred: false, kind: 'used' },
          { name: 'Messages', tokens: 40000, color: 'x', isDeferred: false, kind: 'used' },
          { name: 'Free space', tokens: 150000, color: 'x', isDeferred: false, kind: 'free' },
        ],
      },
    },
    rateLimits: LIMITS,
    cost: { usd: 1.5 },
  } }) as never)

  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: LIMITS,
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits'],
  })
  await $.turn.complete({
    answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'completed',
    usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 45000, cache_creation_input_tokens: 3000, model: 'm' },
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'burnrate', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2h 30m' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '85%' }))?.props.color).toBe('#e5534b')
    expect(await ui.find({ type: 'Text', text: 'cache read' })).toBeUndefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: '45k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Free space' })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})
