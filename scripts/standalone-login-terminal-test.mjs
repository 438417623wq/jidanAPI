import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

/** 使用替身启动器验收登录前入口，回归测试不弹窗口或接触用户剪贴板。 */
export async function verifyLoginTerminal() {
  const { createManagement } = await import('../packages/standalone/management.mjs')
  let baseUrl
  let attempts = 0
  let rejectLaunch = true
  let holdLaunch = true
  let finishLaunch
  let launchStarted
  const started = new Promise(resolve => { launchStarted = resolve })
  const dataDir = 'F:\\测试目录\\带空格与单引号\'\\独立服务'
  const key = 'ofm-test-private-key'
  const management = createManagement({
    stores: { settings: { get: () => ({ forwardKey: key }) } },
    info: () => ({ baseUrl, dataDir }),
    loginTerminal: async received => {
      assert.equal(received, dataDir)
      attempts++
      if (rejectLaunch) throw new Error('测试启动失败')
      if (!holdLaunch) return
      const finished = new Promise(resolve => { finishLaunch = resolve })
      launchStarted()
      await finished
    },
  })
  const server = http.createServer((req, res) => { void management.handleRequest(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  baseUrl = `http://127.0.0.1:${port}`
  management.setPort(port)
  const source = { origin: baseUrl, 'sec-fetch-site': 'same-origin' }
  const request = (body = {}, headers = source, route = '/login/terminal', method = 'POST', url = baseUrl) => fetch(`${url}/api/management${route}`, {
    method, headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  try {
    assert.equal((await request({}, {})).status, 403)
    assert.equal((await request({}, { origin: baseUrl })).status, 403)
    assert.equal((await request({}, { ...source, origin: 'https://evil.example' })).status, 403)
    assert.equal((await request({}, { ...source, 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await request({}, { ...source, referer: 'http://evil.example/' })).status, 403)
    assert.equal((await request({}, source, '/login/terminal', 'GET')).status, 401)
    for (const body of [{ command: 'whoami' }, { dataDir: 'C:\\Windows' }, { key }]) {
      assert.equal((await request(body)).status, 400)
    }
    assert.equal(attempts, 0)
    const aliasUrl = `http://localhost:${port}`
    assert.equal((await request({}, source, '/login/terminal', 'POST', aliasUrl)).status, 403)
    const failure = await request({}, { origin: aliasUrl, 'sec-fetch-site': 'same-origin' }, '/login/terminal', 'POST', aliasUrl)
    assert.equal(failure.status, 500)
    assert.ok(!(await failure.text()).includes(dataDir))
    assert.equal(attempts, 1)
    rejectLaunch = false
    const pending = request()
    await Promise.race([started, pending.then(response => {
      throw new Error(`启动器未执行，请求提前结束：${response.status}`)
    })])
    assert.equal((await request()).status, 429)
    assert.equal(attempts, 2)
    finishLaunch()
    const opened = await pending
    assert.equal(opened.status, 200)
    assert.deepEqual(await opened.json(), { ok: true })
    assert.equal((await request()).status, 429)
    assert.equal(attempts, 2)
    holdLaunch = false
    const nativeNow = Date.now
    const afterCooldown = nativeNow() + 31_000
    try {
      Date.now = () => afterCooldown
      assert.equal((await request()).status, 200)
      assert.equal(attempts, 3)
    } finally { Date.now = nativeNow }
    // 打开本机窗口不创建管理会话，网页仍须粘贴令牌登录。
    assert.equal((await request({}, source, '/key', 'GET')).status, 401)
  } finally {
    finishLaunch?.()
    management.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
