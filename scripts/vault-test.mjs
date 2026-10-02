/**
 * The co-paid lane: seal, gate, and wire, offline.
 *
 * Four layers are pinned here, each because its failure would be silent in
 * production:
 *
 * 1. **The seal opens where it should and nowhere else.** The shipped seal must
 *    decrypt (shape checks only — the plaintext never appears in this suite),
 *    tampered bytes and wrong shards must fail closed, and the host gate must
 *    admit exactly the two desktop shells and refuse everything else,
 *    including a lone forged signal.
 * 2. **No readable credential ships.** Every file the package publishes is
 *    scanned for key and endpoint shapes; the minting tool must be ignored by
 *    git; the scan needles are assembled at runtime so this file never
 *    matches itself.
 * 3. **The adapter's sealed branch fails locked, streams unlocked.** A locked
 *    host yields one non-retryable turn failure; an unlocked one reaches a
 *    local stand-in relay with the bearer header, streams DeepSeek-style
 *    reasoning frames through the harness chunk protocol, and accounts usage.
 * 4. **The roster exists only where the gate opens.** A full boot of the Host
 *    half with the Tauri shell's signals simulated lists the sealed models on
 *    the main route; the same boot without them lists none.
 *
 * Local network only: the "relay" is a loopback HTTP server. The real lane is
 * never contacted, and the free lane's quota is not spent.
 *
 * Run: node scripts/vault-test.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const repo = fileURLToPath(new URL('..', import.meta.url))

// The lane's wire module reads UPSTREAM_BASE once for the free lane; the sealed
// lane has its own base from the seal. Import order matters for the boot blocks.
process.env.OUR_FREE_MODEL_BASE ??= 'http://127.0.0.1:9'
const { detectSealedHost, unlockSealedLane, openSeal, openSealWith, deriveSealKey, SEAL_AAD, IV_BYTES, TAG_BYTES } = await import('../src/vault.js')
const { buildEacCatalog, eacDisplayName, isEacEntry, EAC_CHANNEL } = await import('../src/catalog.js')
const { FreeModelAdapter } = await import('../src/adapter.js')

// ── 1. the seal and the gate ─────────────────────────────────────────────────
{
  const opened = openSeal()
  check('the shipped seal opens', opened !== null, true)
  check('its endpoint is an https URL with a path', opened !== null && opened.base.startsWith('https://') && new URL(opened.base).pathname.length > 1, true)
  check('its credential matches the lane key shape', opened !== null && /^[\w-]{20,}$/.test(opened.apiKey), true)

  const plainWeb = detectSealedHost({ env: {}, execPath: '/usr/bin/node', argv: ['node', 'bin.js', 'web', '--port', '3099'] })
  check('the gate refuses a plain web host', plainWeb, null)
  const partialAio = detectSealedHost({
    env: { DSH_HOME: '/home/u/AppData/Roaming/com.deepseek.dsh.desktop.aio/releases/6.9.3/dsh-home' },
    execPath: '/usr/local/bin/node',
    argv: ['node', 'bin.js', 'web'],
  })
  check('the gate refuses one Tauri signal alone (home path only)', partialAio, null)
  const forgedHarness = detectSealedHost({ env: {}, profileName: 'desktop' })
  check('the gate refuses a desktop profile name without the run-as-node marker', forgedHarness, null)
  const aio = detectSealedHost({
    env: { DSH_HOME: 'C:/Users/u/AppData/Roaming/com.deepseek.dsh.desktop.aio/releases/6.9.3/dsh-home' },
    execPath: 'D:/DSHEAC AIO/resources/node/node.exe',
    argv: ['node', 'bin.js', 'web', '--host', '127.0.0.1', '--port', '57543', '--profile', 'web-desktop'],
  })
  check('the gate admits the Tauri shell on the full signal trio', aio, 'aio')
  const harness = detectSealedHost({ env: { ELECTRON_RUN_AS_NODE: '1' }, profileName: 'desktop' })
  check('the gate admits the Electron shell on profile + marker', harness, 'harness')
  const unlockedHere = unlockSealedLane({ profileName: undefined })
  check('unlock returns nothing on this (unapproved) test host', unlockedHere, null)
}

{
  // A full mint → open round trip with throwaway shards, then every tamper the
  // suite can think of must land on null — including the two failure modes that
  // matter most in practice: a swapped shard file and a flipped payload byte.
  const shards = [crypto.randomBytes(24), crypto.randomBytes(24), crypto.randomBytes(24)]
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveSealKey(shards), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(SEAL_AAD, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify({ v: 1, m: 'eac', u: 'https://lane.example/v1', k: 'sk-roundtrip-credential-0001' }), 'utf8')
  const packed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const opened = openSealWith(shards, packed)
  check('a fresh mint opens with the exact credential', opened, { base: 'https://lane.example/v1', apiKey: 'sk-roundtrip-credential-0001' })

  const wrongShards = [...shards]
  wrongShards[2] = crypto.randomBytes(24)
  check('a foreign third shard fails closed', openSealWith(wrongShards, packed), null)

  const tampered = Buffer.from(packed)
  tampered[tampered.length - TAG_BYTES - 1] ^= 0x01
  check('a flipped ciphertext byte fails closed', openSealWith(shards, tampered), null)

  const tamperedTag = Buffer.from(packed)
  tamperedTag[tamperedTag.length - 1] ^= 0x01
  check('a flipped auth tag fails closed', openSealWith(shards, tamperedTag), null)

  const shortShard = [shards[0], Buffer.from('tiny'), shards[2]]
  check('an undersized shard fails closed', openSealWith(shortShard, packed), null)

  const truncated = packed.subarray(0, IV_BYTES + TAG_BYTES - 3)
  check('a truncated payload fails closed', openSealWith(shards, truncated), null)
}

// ── 2. nothing readable ships ────────────────────────────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const files = []
  const collect = relative => {
    const absolute = path.join(repo, relative)
    if (!fs.existsSync(absolute)) return
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute)) collect(path.join(relative, name))
      return
    }
    files.push(relative)
  }
  for (const entry of pkg.files) collect(entry)

  // Assembled at runtime so this source file never contains (and can never be
  // found by) the shapes it scans for.
  const needles = {
    'a key prefix with payload': 'sk-' + 'x'.repeat(4),
    'the lane host fragment': ['dtyg', '123'].join(''),
    'a bearer prefix with payload': 'Bearer ' + 'sk',
  }
  for (const relative of files) {
    const text = fs.readFileSync(path.join(repo, relative), 'utf8')
    for (const [name, needle] of Object.entries(needles)) {
      check(`${relative} carries no ${name}`, text.includes(needle), false)
    }
  }

  const { execFileSync } = await import('node:child_process')
  let mintIgnored = false
  try {
    execFileSync('git', ['check-ignore', '--quiet', 'scripts/eac-vault-mint.mjs'], { cwd: repo })
    mintIgnored = true
  } catch { /* not ignored */ }
  check('the minting tool is git-ignored (plaintext stays out of the repo)', mintIgnored, true)
}

// ── 3. the adapter's sealed branch ───────────────────────────────────────────
{
  // A stand-in relay speaking exactly what the lane speaks: chat SSE with
  // DeepSeek-style `reasoning_content`, the finish token and the usage riding
  // the same final frame, `[DONE]` at the end.
  const seen = []
  const relay = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      seen.push({ path: req.url, authorization: req.headers.authorization, model: body.model, maxTokens: body.max_tokens, stream: body.stream })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'ing' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ans' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'wer', reasoning_content: '.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  relay.unref()
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const sealedEntry = {
    id: 'deepseek-ai/deepseek-v4.1-flash', name: 'EAC DeepSeek V4.1 Flash', channel: 'eac', wire: 'chat',
    vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000, canDisableThinking: false, regionSensitive: false,
  }
  const state = () => ({ catalog: [sealedEntry], membership: { 'our-free-model': [sealedEntry.id] }, settings: {}, attributionUserAgent: '' })

  const locked = new FreeModelAdapter({ state, sealedCredential: () => null, recordUsage: () => {}, recordTurn: () => {} })
  const lockedChunks = []
  for await (const chunk of locked.stream({ model: sealedEntry.id, messages: [{ role: 'user', content: 'hi' }] }, sealedEntry, state())) lockedChunks.push(chunk)
  const lockedFinish = lockedChunks.find(chunk => chunk.type === 'finish')
  check('a locked host fails its turn non-retryably', lockedFinish?.reason?.failure?.code, 'LANE_LOCKED')
  check('the locked failure names nothing about the lane', (lockedFinish?.reason?.failure?.message ?? '').includes('http'), false)

  const adapter = new FreeModelAdapter({ state, sealedCredential: () => ({ base: relayBase, apiKey: 'sk-relay-credential-0123456789' }), recordUsage: () => {}, recordTurn: () => {} })
  const chunks = []
  for await (const chunk of adapter.stream({ model: sealedEntry.id, messages: [{ role: 'user', content: 'hi' }] }, sealedEntry, state())) chunks.push(chunk)
  const kinds = chunks.map(chunk => chunk.type)
  check('the turn streams reasoning deltas from reasoning_content', kinds.includes('reasoning-delta'), true)
  check('and text deltas', kinds.includes('text-delta'), true)
  const reasoning = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  check('the reasoning text arrives in order', reasoning, 'thinking.')
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  check('the answer text arrives whole', text, 'answer')
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
  check('usage is accounted with the reasoning split', [usage?.inputTokens, usage?.outputTokens, usage?.reasoningTokens], [9, 6, 4])
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('the turn finishes clean', finish?.reason?.kind, 'stop')
  check('the relay saw the bearer credential', seen[0]?.authorization, 'Bearer sk-relay-credential-0123456789')
  check('and the raw namespaced model id', seen[0]?.model, 'deepseek-ai/deepseek-v4.1-flash')
  check('and a bounded streaming request', [seen[0]?.stream, typeof seen[0]?.maxTokens === 'number' && seen[0]?.maxTokens > 0], [true, true])
  await new Promise(resolve => relay.close(resolve))
}

// ── roster shape ─────────────────────────────────────────────────────────────
{
  const roster = buildEacCatalog([
    'deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3-flash', 'unheard-org/some-model-9',
  ])
  check('every roster row carries the channel tag field', roster.every(entry => entry.channel === EAC_CHANNEL), true)
  check('and the chat wire', roster.every(entry => entry.wire === 'chat'), true)
  check('known ids display as the model name under the channel tag', roster.slice(0, 3).map(entry => entry.name), [
    'EAC DeepSeek V4.1 Flash', 'EAC Kimi K3', 'EAC GLM 5.3 Flash',
  ])
  check('an unknown id still shows its own name, tagged', roster[3].name, 'EAC Some Model 9')
  check('the ids stay the raw namespaced ids', roster[0].id, 'deepseek-ai/deepseek-v4.1-flash')
  check('isEacEntry answers the channel field', [isEacEntry(roster[0]), isEacEntry({ id: 'mimo-v2.6-flash-free' })], [true, false])
  check('display names never leak the org prefix', roster.every(entry => !entry.name.includes('deepseek-ai/') && !entry.name.includes('moonshotai/')), true)
}

// ── 4. the Host half boots the lane only where the gate opens ────────────────
{
  const { apply, inject } = await import('../index.js')
  const { ROUTE_MAIN } = await import('../src/adapter.js')

  // The listing the seal decrypts to, served by a fetch stand-in so the suite
  // never contacts the real lane. Every other URL refuses, like an offline host.
  const credential = openSeal()
  const rosterIds = ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3']
  const realFetch = globalThis.fetch
  const stubbedFetch = async (url, options) => {
    const text = String(url)
    if (credential !== null && text.startsWith(credential.base)) {
      if (text.endsWith('/models')) {
        return new Response(JSON.stringify({ data: rosterIds.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{"error":{"message":"relay stood down for the suite"}}', { status: 503 })
    }
    void options
    throw new TypeError('fetch failed (offline suite)')
  }

  /** Simulate the Tauri shell's signals around one boot. */
  async function bootWith({ simulateAio }) {
    const previousArgv = [...process.argv]
    const previousExecPath = process.execPath
    const previousHome = process.env.DSH_HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), simulateAio ? 'ofm-aio-com.deepseek.dsh.desktop.aio-' : 'ofm-vault-'))
    process.env.DSH_HOME = home
    let aioExecPath = ''
    if (simulateAio) {
      aioExecPath = path.join(home, 'resources', 'node', 'node.exe')
      process.execPath = aioExecPath
      process.argv.push('web-desktop')
    }
    globalThis.fetch = stubbedFetch
    const routes = []
    const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
    apply(ctx, configOf())
    const api = () => routes.find(route => route.kind === 'prefix')?.handler
    try {
      await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 8000 })
      await until(() => {
        const adapter = ctx.__captured.adapters[0]?.adapter
        return adapter !== undefined && adapter.listModels !== undefined
      }, { what: 'the adapter', timeoutMs: 8000 })
      return { ctx, api, home, restore: () => {
        process.argv = previousArgv
        process.execPath = previousExecPath
        process.env.DSH_HOME = previousHome
        globalThis.fetch = realFetch
        for (const disposer of ctx.__disposers.reverse()) {
          try { disposer() } catch { /* teardown best effort */ }
        }
        fs.rmSync(home, { recursive: true, force: true })
      } }
    } catch (error) {
      process.argv = previousArgv
      process.execPath = previousExecPath
      process.env.DSH_HOME = previousHome
      globalThis.fetch = realFetch
      for (const disposer of ctx.__disposers.reverse()) {
        try { disposer() } catch { /* teardown best effort */ }
      }
      fs.rmSync(home, { recursive: true, force: true })
      throw error
    }
  }

  // The boot effect needs a config-free apply; keep the shape offline-test uses.
  const configOf = () => ({})

  {
    const { ctx, api, restore } = await bootWith({ simulateAio: true })
    try {
      const adapter = ctx.__captured.adapters[0]?.adapter
      await until(async () => (await adapter.listModels(ROUTE_MAIN)).some(model => model.id === 'deepseek-ai/deepseek-v4.1-flash'), {
        what: 'the sealed roster arriving', timeoutMs: 10000,
      })
      const models = await adapter.listModels(ROUTE_MAIN)
      const sealed = models.find(model => model.id === 'deepseek-ai/deepseek-v4.1-flash')
      check('the Tauri boot lists the sealed model under the main route', sealed !== undefined, true)
      check('with the model name under the channel tag', sealed?.name, 'EAC DeepSeek V4.1 Flash')
      const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
      const summaryRow = (summary.json.catalog ?? []).find(entry => entry.id === 'moonshotai/kimi-k3')
      check('the settings page row is marked available with the channel field', [summaryRow?.availability, summaryRow?.channel], ['available', 'eac'])
      check('the settings page row carries the tag prefix in its name', summaryRow?.name, 'EAC Kimi K3')
      check('the settings API exposes no credential material anywhere', JSON.stringify(summary.json).includes('sk-'), false)
      const rosterIdsShown = (summary.json.catalog ?? []).filter(entry => entry.channel === 'eac').map(entry => entry.id)
      check('all listed sealed models made the roster', rosterIdsShown.slice().sort(), rosterIds.slice().sort())
    } finally {
      restore()
    }
  }

  {
    const { ctx, api, restore } = await bootWith({ simulateAio: false })
    try {
      const adapter = ctx.__captured.adapters[0]?.adapter
      await until(async () => (await adapter.listModels(ROUTE_MAIN)).length > 0, { what: 'the free roster', timeoutMs: 10000 })
      const models = await adapter.listModels(ROUTE_MAIN)
      check('an unapproved host lists no sealed models', models.some(model => model.id.includes('/') || model.name.startsWith('EAC ')), false)
      const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
      check('and its settings page has no sealed rows at all', (summary.json.catalog ?? []).some(entry => entry.channel === 'eac'), false)
    } finally {
      restore()
    }
  }
}

console.log(failures === 0 ? '\nvault-test: all checks passed' : `\nvault-test: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
