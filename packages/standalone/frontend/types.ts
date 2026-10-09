export type Page = 'overview' | 'models' | 'usage' | 'channels' | 'eac' | 'settings' | 'connection'
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: { enabled: boolean; probeIntervalMinutes: number; standaloneProbe: boolean }
  channels: { state: string; error?: string }
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: { id: string; name: string; channel: string; routable: boolean }[]
}
export interface Stats {
  requests: number
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number }
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  logout(): Promise<void>
  error(error: Error): void
}
