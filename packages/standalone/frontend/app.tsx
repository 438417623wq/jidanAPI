import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Sidebar, Topbar } from './components/shell'
import { Overview } from './components/overview'
import { startLegacy } from './legacy'
import type { Host, Page, Snapshot } from './types'
import './app.css'

const roots = new Map<string, Root>()
const root = (id: string) => {
  if (!roots.has(id)) roots.set(id, createRoot(document.getElementById(id)!))
  return roots.get(id)!
}
let host: Host
let current: Snapshot | undefined
let currentPage: Page = 'overview'
let channelGeneration = 0
let channelModule: typeof import('./channels.mjs') | undefined
let channelImport: Promise<typeof import('./channels.mjs')> | undefined
let channelMounted = false

function hideChannels() {
  channelGeneration++
  if (channelMounted) { channelModule?.hide(); channelMounted = false }
}
function showChannels(kind: 'channels' | 'eac', summary: Snapshot['summary'] & { reload(): void }) {
  if (channelModule) {
    channelGeneration++
    document.getElementById('channel-root')!.removeAttribute('role')
    channelModule.show(kind, summary)
    channelMounted = true
    return
  }
  const generation = ++channelGeneration
  const container = document.getElementById('channel-root')!
  container.textContent = '正在加载渠道管理…'
  container.setAttribute('role', 'status')
  channelImport ??= import('./channels.mjs').catch(error => { channelImport = undefined; throw error })
  void channelImport.then(module => {
    if (generation !== channelGeneration || !current || currentPage !== kind) return
    container.removeAttribute('role')
    container.textContent = ''
    channelModule = module
    module.show(kind, summary)
    channelMounted = true
  }).catch(() => {
    if (generation !== channelGeneration || !current || currentPage !== kind) return
    container.textContent = ''
    const error = document.createElement('p')
    error.textContent = '渠道页面加载失败，请检查本地服务是否运行。'
    const retry = document.createElement('button')
    retry.className = 'secondary'; retry.textContent = '重试加载渠道'
    retry.onclick = () => showChannels(kind, summary)
    container.append(error, retry)
  })
}
host = startLegacy({
  update(snapshot: Snapshot, page: Page) {
    current = snapshot
    currentPage = page
    root('sidebar-root').render(<Sidebar page={page} summary={snapshot.summary} host={host} />)
    root('topbar-root').render(<Topbar page={page} summary={snapshot.summary} />)
    root('page-overview').render(<Overview {...snapshot} host={host} />)
  },
  clear() {
    current = undefined
    hideChannels()
    for (const value of roots.values()) value.render(null)
    document.getElementById('channel-root')!.replaceChildren()
  },
  channels(kind: 'channels' | 'eac', summary: Snapshot['summary'] & { reload(): void }) {
    // 导航先更新目标，再启动异步页面，避免快速切页时迟到挂载。
    currentPage = kind
    showChannels(kind, summary)
  },
  hideChannels,
})
