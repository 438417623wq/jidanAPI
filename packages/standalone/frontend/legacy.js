import { providers } from 'ofm-provider-list'
let view
/* 独立服务页面仅使用同源管理接口，不依赖 DSH 或外部 CDN。 */
const $ = id => document.getElementById(id)
const API = '/api/management'
window.addEventListener('ofm:unauthorized', () => showLogin('管理会话已失效，请重新登录'))
const PAGE_NAMES = { overview: '概览', models: '模型清单', usage: '用量统计', channels: '免费账号渠道', eac: 'EAC 协付渠道', settings: '服务设置', connection: 'API 接入' }
const STATE_NAMES = { available: '已探测可用', listed: '清单已收录', unknown: '未探测', unavailable: '不可用', throttled: '限流中', 'region-blocked': '地区受限' }
let summary
let stats
let apiKey = ''
let page = 'overview'
let settingsDirty = false
let pollTimer
let loading
let authenticated = false
let generation = 0
let testInProgress = false
const fmt = value => new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0)
const short = value => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : fmt(value)
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未刷新'
const text = (id, value) => { $(id).textContent = value }
const loginPlatform = $('login-terminal').dataset.loginPlatform
const loginTerminalName = loginPlatform === 'windows' ? 'PowerShell' : '终端'
const canOpenLoginTerminal = ['windows', 'macos'].includes(loginPlatform)
if (canOpenLoginTerminal) {
  $('login-terminal').disabled = false
  text('login-terminal', `打开${loginTerminalName === 'PowerShell' ? ' PowerShell ' : '终端'}获取令牌 ↗`)
  text('login-terminal-help', `点击下方按钮，会打开${loginTerminalName}并将当前服务的令牌复制到剪贴板。回来粘贴到上方即可。`)
} else {
  text('login-terminal-help', '当前系统不支持自动打开终端，请展开下方说明手动获取令牌。')
}
text('login-command-label', `${loginPlatform === 'windows' ? 'Windows PowerShell' : loginPlatform === 'macos' ? 'macOS 终端' : '终端'}命令（默认目录）`)
if (loginPlatform !== 'windows') {
  $('login-command').value = loginPlatform === 'macos'
    ? `node -e 'const fs = require("node:fs"); const {execFileSync} = require("node:child_process"); const key = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); execFileSync("/usr/bin/pbcopy", [], {input: key});' "$HOME/.our-free-model/settings.json"`
    : `node -e 'const fs = require("node:fs"); const key = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); process.stdout.write(key + "\\n");' "$HOME/.our-free-model/settings.json"`
}
const node = (tag, className, value) => {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (value !== undefined) element.textContent = value
  return element
}

async function request(path, body, timeoutMs = 10000) {
  const current = generation
  const response = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = Object.assign(new Error(value.error ?? `请求失败（${response.status}）`), { status: response.status })
    if (response.status === 401 && path !== '/session') showLogin(error.message)
    throw error
  }
  if (current !== generation) throw new Error('管理会话已变化，请重新操作。')
  return value
}

function showLogin(message = '') {
  authenticated = false
  view?.clear()
  generation++
  summary = undefined
  stats = undefined
  apiKey = ''
  settingsDirty = false
  clearTimeout(pollTimer)
  $('app').hidden = true
  $('loading-screen').hidden = true
  $('login-screen').hidden = false
  $('connection-key').value = ''
  $('connection-key').type = 'password'
  $('copy-key').disabled = true
  $('test-result').hidden = true
  text('test-result-meta', '')
  text('test-result-text', '')
  $('notice').hidden = true
  $('error-notice').hidden = true
  text('show-key', '查看密钥')
  text('login-error', message)
  text('login-help-status', '')
}

function errorNotice(error) {
  if (!authenticated) return
  const reason = error.name === 'TimeoutError' ? '请求超时，请检查服务是否仍在运行。' : error.message
  $('error-notice').querySelector('span').textContent = reason
  $('error-notice').hidden = false
}

function notice(message) {
  text('notice', message)
  $('notice').hidden = false
}

async function action(button, run, message) {
  if (button.disabled) return
  button.disabled = true
  $('error-notice').hidden = true
  try {
    await run()
    if (authenticated && message) notice(message)
  } catch (error) { errorNotice(error) }
  finally { button.disabled = false }
}

function navigate(next) {
  if (!Object.hasOwn(PAGE_NAMES, next)) return
  page = next
  for (const name of ['overview', 'models', 'usage', 'settings', 'connection']) $(`page-${name}`).hidden = name !== next
  const channelPage = next === 'channels' || next === 'eac'
  $('page-channel').hidden = !channelPage
  if (channelPage) {
    view?.channels(next, { ...summary, reload: () => { void loadData().catch(errorNotice) } })
  } else view?.hideChannels()
  document.querySelectorAll('[data-page]').forEach(button => {
    button.classList.toggle('active', button.dataset.page === next)
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  if (summary) {
    if (page === 'models') renderModels()
    if (page === 'usage') renderUsage()
    view?.update({ summary, stats }, page)
  }
  $('rotate-confirm').hidden = true
}

function dayId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function chart(id, count) {
  const values = new Map((stats.days ?? []).map(row => [row.day, row.total]))
  const days = []
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  for (let index = count - 1; index >= 0; index--) {
    const at = new Date(today)
    at.setDate(at.getDate() - index)
    days.push({ day: dayId(at), total: values.get(dayId(at)) ?? 0 })
  }
  const max = Math.max(1, ...days.map(row => row.total))
  const container = $(id)
  container.replaceChildren()
  container.setAttribute('role', 'img')
  container.setAttribute('aria-label', `最近 ${count} 天 Token 用量：${days.map(row => `${row.day} ${fmt(row.total)}`).join('；')}`)
  for (const row of days) {
    const column = node('div', 'chart-column')
    column.title = `${row.day} · ${fmt(row.total)} Token`
    const value = node('span', 'chart-value', row.total ? short(row.total) : '')
    const bar = node('div', `chart-bar${row.total ? '' : ' chart-zero'}`)
    bar.style.height = `${Math.max(2, row.total / max * 75)}%`
    column.append(value, bar, node('span', 'chart-label', row.day.slice(5).replace('-', '/')))
    container.append(column)
  }
}

function renderModels() {
  const search = $('model-search').value.trim().toLowerCase()
  const channel = $('model-channel').value
  const models = summary.catalog.filter(row => (
    (channel === 'all' || row.channel === channel)
    && `${row.name} ${row.id}`.toLowerCase().includes(search)
  ))
  text('model-result-count', `${models.length} 个模型`)
  const list = $('model-list')
  list.replaceChildren()
  for (const model of models) {
    const card = node('article', 'model-card')
    const header = node('div', 'model-card-header')
    const title = node('div')
    title.append(node('h2', '', model.name), node('div', 'model-id', model.id))
    header.append(title, node('span', 'channel-mark', model.channel === 'anonymous' ? 'A' : model.channel.slice(0, 1).toUpperCase()))
    const badges = node('div', 'model-badges')
    badges.append(node('span', '', channelName(model.channel)), node('span', '', model.vision ? '视觉' : '纯文本'))
    if (model.reasoning) badges.append(node('span', '', '思考模型'))
    const capacity = node('div', 'model-capacity')
    capacity.append(node('span', '', `上下文 ${model.contextWindow ? short(model.contextWindow) : '未知'}`), node('span', '', `输出 ${model.maxOutput ? short(model.maxOutput) : '未知'}`))
    const footer = node('div', 'model-card-footer')
    const availability = node('span', `availability ${model.availability}`, STATE_NAMES[model.availability] ?? '未知')
    if (!model.routable) availability.textContent += ' · 未公开'
    const actions = node('div', 'actions')
    const copy = node('button', 'text-button', '复制 ID')
    copy.addEventListener('click', () => { void copyText(model.id).catch(errorNotice) })
    const test = node('button', 'text-button', '测试 ↗')
    test.disabled = testInProgress || !model.routable || !summary.settings.enabled
    test.addEventListener('click', () => {
      void action(test, async () => {
        if (testInProgress) return
        testInProgress = true
        renderModels()
        try {
          notice(`正在测试 ${model.name}，会发送少量推理请求…`)
          const result = await request('/models/test', { model: model.id }, 70000)
          text('test-result-meta', `${model.name} · ${fmt(result.latencyMs)} ms`)
          text('test-result-text', result.text || '请求已完成，上游没有返回可见正文。')
          $('test-result').hidden = false
          await loadData()
        } finally {
          testInProgress = false
          if (summary) renderModels()
        }
      }, '模型测试完成')
    })
    actions.append(copy, test)
    footer.append(availability, actions)
    card.append(header, badges, capacity, footer)
    list.append(card)
  }
  if (!models.length) list.append(node('p', 'empty-state', '没有匹配的模型，试试其他名称或渠道。'))
}

function renderUsage() {
  text('usage-requests', fmt(stats.requests))
  text('usage-failed', fmt(stats.failedTurns))
  text('usage-estimate', stats.logicalEstimated ? '包含迁移前历史估算' : '最终未完成的用户回合')
  text('usage-input', short(stats.grand.input))
  text('usage-output', short(stats.grand.output))
  chart('usage-chart', 14)
  const rows = $('usage-models')
  rows.replaceChildren()
  for (const model of [...stats.models].sort((a, b) => b.calls - a.calls)) {
    const row = node('tr')
    for (const value of [model.name, fmt(model.turns), fmt(model.calls), fmt(model.input), fmt(model.output), fmt(model.failedTurns)]) row.append(node('td', '', value))
    rows.append(row)
  }
  $('usage-empty').hidden = stats.models.length > 0
}

function render() {
  $('test-mode-notice').hidden = summary.networkMode !== 'fixture'
  const select = $('model-channel')
  const selected = select.value
  select.replaceChildren(new Option('全部渠道', 'all'))
  for (const channel of new Set(['anonymous', 'kilo', 'eac', ...summary.catalog.map(row => row.channel)])) select.add(new Option(channelName(channel), channel))
  select.value = [...select.options].some(option => option.value === selected) ? selected : 'all'
  if (page === 'channels' || page === 'eac') view?.channels(page, { ...summary, reload: () => { void loadData().catch(errorNotice) } })
  const endpoint = `${summary.baseUrl}/v1`
  $('connection-endpoint').value = endpoint
  view?.update({ summary, stats }, page)
  if (!settingsDirty) {
    for (const [name, value] of Object.entries(summary.settings)) {
      const input = $('settings-form').elements.namedItem(name)
      if (!input) continue
      if (input.type === 'checkbox') input.checked = value
      else input.value = value
    }
  }
  text('settings-refresh-note', summary.automaticRefresh ? '自动刷新已启用，保存间隔后会重新安排下一轮。' : '当前以 --no-refresh 启动。此页设置会保存，但自动任务保持暂停；手动刷新仍可用。')
  const model = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  text('connection-example', `curl ${summary.baseUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`)
  if (page === 'models') renderModels()
  if (page === 'usage') renderUsage()
}

function channelName(value) {
  return ({ anonymous: '匿名模型', kilo: 'Kilo 免费池', eac: 'EAC 协付' })[value] ?? providers.find(row => row.id === value)?.name ?? value
}

function loadData() {
  if (loading) return loading
  const current = generation
  loading = Promise.all([request('/summary'), request('/stats')])
    .then(([nextSummary, nextStats]) => {
      if (current !== generation) return
      summary = nextSummary
      stats = nextStats
      authenticated = true
      $('login-screen').hidden = true
      $('loading-screen').hidden = true
      $('app').hidden = false
      $('error-notice').hidden = true
      render()
    })
    .finally(() => { loading = undefined })
  return loading
}

function startPolling() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (!authenticated) return
    try { if (!document.hidden) await loadData() } catch (error) { errorNotice(error) }
    if (authenticated) startPolling()
  }, 15000)
}

async function copyText(value) {
  await navigator.clipboard.writeText(value)
  notice('已复制到剪贴板')
}

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)))
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)))
document.querySelectorAll('[data-copy="endpoint"]').forEach(button => button.addEventListener('click', () => {
  void copyText(`${summary.baseUrl}/v1`).catch(errorNotice)
}))
for (const id of ['usage-refresh', 'retry']) $(id).addEventListener('click', () => {
  void action($(id), loadData, '状态已更新')
})
$('model-search').addEventListener('input', () => { if (summary) renderModels() })
$('model-channel').addEventListener('change', () => { if (summary) renderModels() })
for (const [id, probe] of [['model-refresh', false], ['model-probe', true]]) $(id).addEventListener('click', () => {
  void action($(id), async () => {
    notice(probe ? '正在探测可用性，会发送少量推理请求…' : '正在刷新上游模型清单…')
    await request('/models/refresh', { probe }, 300000)
    await loadData()
  }, probe ? '可用性探测已完成' : '模型清单已更新')
})
$('settings-form').addEventListener('input', () => { settingsDirty = true; text('settings-save-status', '有尚未保存的修改') })
$('settings-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button[type="submit"]')
  const patch = {}
  for (const input of form.elements) if (input.name) patch[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value)
  void action(button, async () => {
    await request('/settings', patch)
    settingsDirty = false
    text('settings-save-status', '已保存')
    await loadData()
  }, '设置已保存并生效')
})
$('show-key').addEventListener('click', () => {
  void action($('show-key'), async () => {
    if (apiKey) {
      apiKey = ''
      $('connection-key').value = ''
      $('connection-key').type = 'password'
      $('copy-key').disabled = true
      text('show-key', '查看密钥')
    } else {
      apiKey = (await request('/key')).key
      $('connection-key').value = apiKey
      $('connection-key').type = 'text'
      $('copy-key').disabled = false
      text('show-key', '隐藏密钥')
    }
  })
})
$('copy-key').addEventListener('click', () => { if (apiKey) void copyText(apiKey).catch(errorNotice) })
$('copy-example').addEventListener('click', () => { void copyText($('connection-example').textContent).catch(errorNotice) })
$('rotate-key').addEventListener('click', () => { $('rotate-confirm').hidden = false; $('rotate-confirm-button').focus() })
$('rotate-cancel').addEventListener('click', () => { $('rotate-confirm').hidden = true })
$('rotate-confirm-button').addEventListener('click', () => {
  void action($('rotate-confirm-button'), async () => {
    apiKey = (await request('/key/rotate', { confirm: true })).key
    $('connection-key').value = apiKey
    $('connection-key').type = 'text'
    $('copy-key').disabled = false
    text('show-key', '隐藏密钥')
    $('rotate-confirm').hidden = true
  }, '密钥已轮换，请更新所有客户端配置')
})
$('login-terminal').addEventListener('click', () => {
  const button = $('login-terminal')
  button.disabled = true
  text('login-help-status', `正在本机打开${loginTerminalName}…`)
  void (async () => {
    try {
      await request('/login/terminal', {}, 15000)
      text('login-help-status', `已请求打开${loginTerminalName}。窗口提示复制成功后，回到这里粘贴令牌。`)
      $('login-key').focus()
    } catch (error) {
      text('login-help-status', `${error.message}。可以展开下方的手动获取说明。`)
    } finally { button.disabled = false }
  })()
})
$('copy-login-command').addEventListener('click', () => {
  void navigator.clipboard.writeText($('login-command').value)
    .then(() => text('login-help-status', `命令已复制。在${loginTerminalName}执行后，回到上方粘贴令牌。`))
    .catch(() => {
      $('login-command').focus()
      $('login-command').select()
      text('login-help-status', `浏览器未允许复制，已选中命令，请按 ${loginPlatform === 'macos' ? 'Command+C' : 'Ctrl+C'} 手动复制。`)
    })
})
$('login-form').addEventListener('submit', event => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button')
  button.disabled = true
  text('login-error', '')
  void (async () => {
    try {
      await request('/session', { key: $('login-key').value.trim() })
      $('login-key').value = ''
      await loadData()
      startPolling()
    } catch (error) { text('login-error', error.message) }
    finally { button.disabled = false }
  })()
})

async function boot() {
  const token = new URLSearchParams(location.hash.slice(1)).get('login')
  if (token) history.replaceState(null, '', location.pathname + location.search)
  try {
    if (token) await request('/session', { bootstrapToken: token })
    await loadData()
    navigate(page)
    startPolling()
  } catch (error) {
    showLogin(error.status === 401 && !token ? '' : error.message)
  }
}
export function startLegacy(nextView) {
  view = nextView
  void boot()
  return {
    navigate, refresh: loadData, copy: copyText, error: errorNotice,
    async logout() { await request('/logout', {}); showLogin('已退出管理') },
  }
}
