/** 执行实际页面承载逻辑，以可控请求顺序验证保存与轮询、退出的交错。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

export async function verifySettingsHost() {
  const source = fs.readFileSync(new URL('../packages/standalone/frontend/legacy.js', import.meta.url), 'utf8')
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: { loginPlatform: 'windows' }, textContent: '', hidden: false, value: '',
      addEventListener() {}, querySelector: () => element(`${id}-child`),
    })
    return elements.get(id)
  }
  const requests = []
  let snapshot
  let cleared = 0
  const context = {
    document: { getElementById: element, querySelectorAll: () => [], hidden: false },
    window: { addEventListener() {} },
    location: { hash: '' }, navigator: {}, AbortSignal, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {},
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    harnessView: {
      update(value) { snapshot = value },
      clear() { cleared++ },
      hideChannels() {},
    },
  }
  vm.runInNewContext(source.replace('export function startLegacy', 'function startLegacy') +
    '\nglobalThis.harnessHost = startLegacy(harnessView)', context)
  const host = context.harnessHost
  const answer = (path, body, status = 200) => {
    const index = requests.findIndex(request => request.url === `/api/management${path}`)
    assert.ok(index >= 0, `缺少请求 ${path}`)
    const [request] = requests.splice(index, 1)
    request.resolve({ ok: status < 400, status, json: async () => body })
    return request
  }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const initial = { enabled: true, exposeRegionModels: true, streamRecovery: true,
    standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15 }
  const summary = { baseUrl: 'http://127.0.0.1:18905', catalog: [], settings: initial }
  answer('/summary', summary)
  answer('/stats', {})
  await flush()
  assert.equal(snapshot.summary.settings.defaultMaxTokens, 32768)

  const oldPoll = host.refresh()
  const accepted = { ...initial, defaultMaxTokens: 8192, enabled: false }
  const saving = host.saveSettings(accepted)
  const write = answer('/settings', { settings: accepted })
  assert.deepEqual(JSON.parse(write.options.body), accepted)
  assert.deepEqual(await saving, accepted)
  assert.equal(snapshot.summary.settings.defaultMaxTokens, 8192)
  // 旧摘要比保存响应更晚回来，不能把页面恢复为旧设置。
  answer('/summary', summary)
  answer('/stats', {})
  await oldPoll
  assert.equal(snapshot.summary.settings.defaultMaxTokens, 8192)
  assert.equal(snapshot.summary.settings.enabled, false)

  const failed = host.saveSettings(initial)
  const failedResult = assert.rejects(failed, /模拟磁盘不可写/)
  answer('/settings', { error: '模拟磁盘不可写' }, 500)
  await failedResult
  assert.equal(snapshot.summary.settings.defaultMaxTokens, 8192, '失败不得提交乐观状态')

  const lateSave = host.saveSettings(initial)
  const lateResult = assert.rejects(lateSave, /管理会话已变化/)
  const logout = host.logout()
  answer('/logout', {})
  await logout
  assert.equal(cleared, 1)
  assert.equal(elements.get('app').hidden, true)
  answer('/settings', { settings: initial })
  await lateResult
  assert.equal(cleared, 1)
  assert.equal(elements.get('app').hidden, true, '迟到写入结果不能恢复已退出页面')
  assert.equal(snapshot.summary.settings.defaultMaxTokens, 8192)
  assert.equal(requests.length, 0)
}
