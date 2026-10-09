/** 界面视觉验收：隔离数据目录和替身上游，不读取真实账号。 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createCredentials } from '../packages/standalone/channels/credentials.mjs'

const modelCount = Number(process.env.OFM_PREVIEW_MODELS ?? 0)
if (!Number.isInteger(modelCount) || modelCount < 0 || modelCount > 1000) throw new Error('替身模型数量必须为 0–1000')
const testDelay = Number(process.env.OFM_PREVIEW_TEST_DELAY_MS ?? 0)
if (!Number.isInteger(testDelay) || testDelay < 0 || testDelay > 60000) throw new Error('替身测试延迟必须为 0–60000 毫秒')
const testRequests = { started: 0, completed: 0, cancelled: 0 }
const recordRequests = () => {
  if (testDelay) fs.writeFileSync('.verify/ui-model-test-requests.json', JSON.stringify(testRequests))
}
const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname.endsWith('/auth/status')) {
    json(res, { configured: true, required: true, authorized: false, repo: 'Ebony-Vinyl/dsh-our-free-model' })
  } else if (pathname.endsWith('/pool')) {
    json(res, { ok: true, inflight: 3, pool: 100, active24h: 5, poolSource: 'configured' })
  } else if (pathname.endsWith('/models')) {
    json(res, { data: [{ id: 'mimo-v2.6-flash-free' }, ...Array.from({ length: modelCount }, (_, index) => ({
      id: `fixture/model-${index}:free`, name: `替身模型 ${index}`, isFree: true,
    }))] })
  } else if (pathname.includes('/console/enterprises/') || pathname.endsWith('/v3/config')) {
    json(res, { data: {
      models: [{ id: 'fixture-free', name: '本机替身模型', credits: 'x0', maxInputTokens: 128000, maxOutputTokens: 4096, supportsImages: true }],
      agents: [{ name: 'craft', models: ['fixture-free'] }],
    } })
  } else if (pathname.endsWith('/chat/completions')) {
    testRequests.started++
    recordRequests()
    res.once('close', () => {
      if (!res.writableEnded) { testRequests.cancelled++; recordRequests() }
    })
    // 仅长清单替身中的指定模型模拟失败，不改变正式渠道或 API。
    if (modelCount === 1000 && Buffer.concat(chunks).toString('utf8').includes('fixture/model-998:free')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '本机替身：模拟测试失败' } }))
      testRequests.completed++
      recordRequests()
      return
    }
    if (testDelay) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); res.off('close', finish); resolve() }
      const timer = setTimeout(finish, testDelay)
      res.once('close', finish)
    })
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK · 本机替身请求已完成' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`)
    testRequests.completed++
    recordRequests()
  } else json(res, { data: { Response: { Data: { Accounts: [] } } } })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OFM_TEST_UPSTREAM = base
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const fixture = new URL('./lib/standalone-channel-fixture.mjs', import.meta.url).href
process.execArgv.push('--import', fixture)
await import(fixture)
const prefix = modelCount ? 'ui-phase1-load' : 'ui-phase1'
const dataDir = path.resolve(`.verify/${prefix}-data`)
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
const state = path.join(dataDir, 'channel-pack/state.json')
if (!fs.existsSync(state)) {
  fs.writeFileSync(state, JSON.stringify({ accounts: [{
    id: 'buddy-preview', provider: 'buddy', nickname: '本机替身账号', enabled: true, refreshable: false,
    createdAt: Date.now(), expiresAt: Date.now() + 86400000, credentialRef: 'BUDDY_ACCOUNT_PREVIEW',
  }], disabledModels: {} }))
  const credentials = createCredentials(dataDir)
  await credentials.set('BUDDY_ACCOUNT_PREVIEW', JSON.stringify({
    access_token: 'fixture-preview', refresh_token: 'fixture-refresh', domain: 'copilot.tencent.com',
    expires_at: String(Date.now() + 86400000), refresh_expires_at: String(Date.now() + 7 * 86400000),
    user_id: 'fixture-user', nickname: '本机替身账号', account_type: 'personal',
  }))
  credentials.dispose()
}
const { startStandalone } = await import('../packages/standalone/service.mjs')
const service = await startStandalone({ dataDir, port: modelCount ? 18902 : 18901 })
await service.ready
fs.writeFileSync(`.verify/${prefix}-url.txt`, service.managementUrl)
console.log(`界面预览：${service.url}（本机替身，非真实账号与上游）`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void service.close().then(() => { upstream.closeAllConnections(); upstream.close() })
})
