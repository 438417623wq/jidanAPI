let view
/* 独立服务页面仅使用同源管理接口，不依赖 DSH 或外部 CDN。 */
const $ = id => document.getElementById(id)
const API = '/api/management'
window.addEventListener('ofm:unauthorized', () => showLogin('管理会话已失效，请重新登录'))
const PAGE_NAMES = { overview: '概览', models: '模型清单', usage: '用量统计', channels: '免费账号渠道', eac: 'EAC 协付渠道', settings: '服务设置', connection: 'API 接入' }
let summary
let stats
let apiKey = ''
let page = 'overview'
let settingsRevision = 0
let pollTimer
let loading
let authenticated = false
let generation = 0
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
async function request(path, body, timeoutMs = 10000, signal) {
  const current = generation
  const response = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
  settingsRevision++
  clearTimeout(pollTimer)
  $('app').hidden = true
  $('loading-screen').hidden = true
  $('login-screen').hidden = false
  $('connection-key').value = ''
  $('connection-key').type = 'password'
  $('copy-key').disabled = true
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
    view?.update({ summary, stats }, page)
  }
  $('rotate-confirm').hidden = true
}

function render() {
  $('test-mode-notice').hidden = summary.networkMode !== 'fixture'
  if (page === 'channels' || page === 'eac') view?.channels(page, { ...summary, reload: () => { void loadData().catch(errorNotice) } })
  const endpoint = `${summary.baseUrl}/v1`
  $('connection-endpoint').value = endpoint
  view?.update({ summary, stats }, page)
  const model = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  text('connection-example', `curl ${summary.baseUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`)
}

function loadData() {
  if (loading) return loading
  const current = generation
  const revision = settingsRevision
  loading = Promise.all([request('/summary'), request('/stats')])
    .then(([nextSummary, nextStats]) => {
      if (current !== generation) return
      // 保存前启动的轮询可能晚到，不能覆盖已确认的设置写入结果。
      summary = revision !== settingsRevision && summary
        ? { ...nextSummary, settings: summary.settings } : nextSummary
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
$('retry').addEventListener('click', () => { void action($('retry'), loadData, '状态已更新') })
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
    testModel(model, signal) { return request('/models/test', { model }, 70000, signal) },
    async refreshModels(probe, signal) {
      await request('/models/refresh', { probe }, 300000, signal)
      if (!signal.aborted) await loadData()
    },
    async saveSettings(patch) {
      const value = await request('/settings', patch)
      settingsRevision++
      if (summary) { summary = { ...summary, settings: value.settings }; render() }
      return value.settings
    },
  }
}
