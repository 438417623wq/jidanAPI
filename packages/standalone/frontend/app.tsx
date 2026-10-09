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
let modelModule: typeof import('./models') | undefined
let modelImport: Promise<void> | undefined
let usageModule: typeof import('./usage') | undefined
let usageImport: Promise<void> | undefined

function renderUsagePage() {
  if (!current) return
  if (usageModule) {
    root('page-usage').render(<usageModule.Usage stats={current.stats} host={host} active={currentPage === 'usage'} />)
    return
  }
  if (currentPage !== 'usage' || usageImport) return
  const container = document.getElementById('page-usage')!
  container.textContent = '正在加载用量统计…'
  container.setAttribute('role', 'status')
  usageImport = import('./usage').then(module => {
    usageModule = module
    container.removeAttribute('role')
    container.replaceChildren()
    renderUsagePage()
  }).catch(() => {
    if (!current || currentPage !== 'usage') return
    container.replaceChildren()
    const error = document.createElement('p')
    error.textContent = '统计页面加载失败，请检查本地服务是否运行。'
    const retry = document.createElement('button')
    retry.className = 'secondary'
    retry.textContent = '重试加载统计'
    retry.onclick = renderUsagePage
    container.append(error, retry)
  }).finally(() => { usageImport = undefined })
}

function renderModelPage() {
  if (!current) return
  if (modelModule) {
    root('page-models').render(<modelModule.Models summary={current.summary} host={host} active={currentPage === 'models'} />)
    return
  }
  if (currentPage !== 'models' || modelImport) return
  const container = document.getElementById('page-models')!
  container.textContent = '正在加载模型清单…'
  container.setAttribute('role', 'status')
  modelImport = import('./models').then(module => {
    modelModule = module
    container.removeAttribute('role')
    container.replaceChildren()
    renderModelPage()
  }).catch(() => {
    if (!current || currentPage !== 'models') return
    container.replaceChildren()
    const error = document.createElement('p')
    error.textContent = '模型页面加载失败，请检查本地服务是否运行。'
    const retry = document.createElement('button')
    retry.className = 'secondary'
    retry.textContent = '重试加载模型'
    retry.onclick = renderModelPage
    container.append(error, retry)
  }).finally(() => { modelImport = undefined })
}

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
    renderModelPage()
    renderUsagePage()
  },
  clear() {
    current = undefined
    hideChannels()
    for (const value of roots.values()) value.render(null)
    document.getElementById('channel-root')!.replaceChildren()
    document.getElementById('page-models')!.removeAttribute('role')
    document.getElementById('page-usage')!.removeAttribute('role')
  },
  channels(kind: 'channels' | 'eac', summary: Snapshot['summary'] & { reload(): void }) {
    // 导航先更新目标，再启动异步页面，避免快速切页时迟到挂载。
    currentPage = kind
    showChannels(kind, summary)
  },
  hideChannels,
})
