/**
 * The forward listener must come up without waiting for the network.
 *
 * Boot is one chain: the outlet, then the catalog round (listing plus a full
 * availability probe — 45 s per model, concurrency 2), then the listeners. The
 * probe round is the slow and fragile part of it: a gateway that answers the
 * listing and then stalls on the pings holds the whole chain until the roster
 * gives up. While it is held, `forward.enabled` is true in the settings file and
 * the settings page says so, yet nothing is listening — the port only comes up
 * when the user clicks 应用, whose POST calls `syncForward()` on its own.
 *
 * A listener answers a local socket and depends on nothing that goes out, so it
 * is started before the round that does. This suite boots a generation whose
 * gateway holds every probe unanswered and pins that the port answers anyway:
 * because the stub cannot release those probes until the suite says so, an
 * answer inside the deadline is an answer from *before* the network round —
 * which is the whole distinction between "started early" and "started late".
 *
 * Run: node scripts/forward-boot-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, freePort, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** Every probe parks here until the suite releases it: one stalled gateway. */
let releaseProbes
const probesHeld = new Promise(resolve => { releaseProbes = resolve })
const stub = await stubUpstream({
  listing: ['mimo-v2.6-flash-free'],
  answer: () => ({ wait: probesHeld }),
})

process.env.OUR_FREE_MODEL_BASE = stub.base
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-forward-boot-'))
process.env.DSH_HOME = scratch
// The settings file is the whole scenario: an install that had the port on,
// reloaded into a fresh generation with no page open to click anything.
const forwardPort = await freePort()
fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
fs.writeFileSync(path.join(scratch, 'our-free-model', 'settings.json'), JSON.stringify({
  version: 1, enabled: true, forward: { enabled: true, host: '127.0.0.1', port: forwardPort },
}), { mode: 0o600 })

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer'], onRegister: route => routes.push(route) })
let bootError
try { apply(ctx, {}) } catch (error) { bootError = error }
check('apply() starts with the port already on', bootError?.message ?? 'none', 'none')

const health = () => fetch(`http://127.0.0.1:${forwardPort}/health`).then(res => res.status).catch(() => 0)
try {
  await until(async () => (await health()) === 200, {
    timeoutMs: 5000, what: 'the forward listener to answer while every probe is held',
  })
  check('the port answers while the probe round is still in flight', await health(), 200)

  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  const listed = await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, {
    headers: { authorization: `Bearer ${stored.forwardKey}` },
  }).catch(() => null)
  check('and serves a roster to its own key', [listed?.status, (await listed?.json())?.data?.length ?? 0], [200, 1])
} catch (error) {
  check(`the port answers while the probe round is still in flight (${error?.message ?? error})`, false, true)
}

// Let the held round finish, so the boot chain runs to its end and the listener
// that came up early is the one it keeps — no rebind, no second port.
releaseProbes()
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API', timeoutMs: 5000 })
try {
  await until(async () => {
    const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
    return summary.json?.settings?.forward?.running === true
  }, { what: 'the boot round to settle with the listener still up', timeoutMs: 10_000 })
  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  check('after the round lands, the same listener is still the one running',
    [summary.json.settings.forward.running, summary.json.settings.forward.actualPort], [true, forwardPort])
  check('and the round itself completed', typeof summary.json.catalog, 'object')
} catch (error) {
  check(`the boot round settles with the listener up (${error?.message ?? error})`, false, true)
}

for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* a suite tearing down must not fail on teardown */ }
}

// 相对 DSH_HOME 仍应读取原目录，核心接收到的路径须由插件入口归一化。
const originalCwd = process.cwd()
const originalDshHome = process.env.DSH_HOME
const relativeDataDir = path.join(scratch, 'relative-dsh', 'our-free-model')
fs.mkdirSync(relativeDataDir, { recursive: true })
fs.writeFileSync(path.join(relativeDataDir, 'settings.json'), JSON.stringify({
  enabled: false, forwardKey: 'relative-home-key',
}))
const relativeCtx = fakeContext({ inject, mounted: ['llm'] })
try {
  process.chdir(scratch)
  process.env.DSH_HOME = './relative-dsh'
  apply(relativeCtx, { distribution: 'managed' })
  check('相对 DSH_HOME 可以启动并读取原目录的设置',
    relativeCtx.__captured.adapters[0]?.adapter.deps.state().settings.forwardKey,
    'relative-home-key')
} catch (error) {
  check(`相对 DSH_HOME 可以启动（${error.message}）`, false, true)
} finally {
  for (const disposer of relativeCtx.__disposers.reverse()) disposer()
  process.chdir(originalCwd)
  process.env.DSH_HOME = originalDshHome
}

await stub.close()
const cleanupTarget = fs.realpathSync(scratch)
if (!cleanupTarget.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('临时目录不在预期清理范围内')
fs.rmSync(cleanupTarget, { recursive: true, force: true })
console.log(failures === 0 ? '\nforward-boot: the port never waits on the network' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
