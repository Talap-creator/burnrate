export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number }
export type Category = { name: string; tokens: number }
export type Snapshot = {
  limits: Limit[]
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'burnrate': {
      snap: Snapshot | null
      lastTurn: Tokens | null
      total: Tokens
      categories: Category[]
      isExpanded: boolean
    }
  }
}
