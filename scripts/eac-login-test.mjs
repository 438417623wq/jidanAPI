/** Offline regressions for the Host delivery path and actual login hook. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEacLoginPoller } from '../src/eac-login.js'
import { readEacUser, writeEacUser } from '../src/eac-user.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch
const link = 'x'.repeat(32)
const token = 'test-user-token-never-visible-in-the-browser'
const credential = { mode: 'worker', base: 'https://gateway.invalid/eac/v1' }
const ok = (extra = {}) => new Response(JSON.stringify({ status: 'ok', token, login: 'octocat', ...extra }))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))
try {
  let polls = 0, acks = 0, writes = 0
  const held = deferred()
  const host = createEacLoginPoller({ credentialOf: () => credential, readUser: readEacUser,
    writeUser: value => { writes++; return writeEacUser(value) }, onSaved() {},
    fetch: async (url, init) => {
      if (url.includes('/auth/ack?')) {
        acks++; assert.equal(init.headers['x-ofm-user'], token)
        assert.equal(readEacUser()?.token, token, 'ACK must follow a readable atomic save')
        return new Response('{}')
      }
      polls++; assert.ok(url.endsWith('&retain=1')); await held.promise
      return ok({ ackRequired: true })
    },
  })
  const first = host.poll(link), concurrent = host.poll(link)
  assert.equal(first, concurrent, 'concurrent requests share the same collector')
  held.resolve()
  const answer = await first
  assert.deepEqual(answer, { status: 'ok', login: 'octocat' })
  assert.equal(JSON.stringify(answer).includes(token), false)
  assert.deepEqual([polls, acks, writes], [1, 1, 1])
  assert.deepEqual(await host.poll(link), answer, 'lost local response can be retried after ACK')
  assert.equal(polls, 1)
  console.log('ok  Host: save/read precedes ACK; concurrent collection and local-response retry; no browser token')

  let canWrite = false, saved = null, acknowledgements = 0
  const storageFailure = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => canWrite ? (saved = value) : null, onSaved() {},
    fetch: async url => {
      if (url.includes('/auth/ack?')) { acknowledgements++; return new Response('{}') }
      return ok({ ackRequired: true })
    },
  })
  assert.deepEqual(await storageFailure.poll(link), { error: 'not-writable' })
  assert.equal(acknowledgements, 0)
  canWrite = true
  assert.equal((await storageFailure.poll(link)).status, 'ok')
  assert.equal(acknowledgements, 1)
  console.log('ok  Host: failed local persistence does not ACK; retry succeeds')

  let oldAcks = 0
  const legacy = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => (saved = value), onSaved() {},
    fetch: async url => { if (url.includes('/ack?')) oldAcks++; return ok() },
  })
  assert.equal((await legacy.poll(link)).status, 'ok'); assert.equal(oldAcks, 0)
  const ackFailure = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => (saved = value), onSaved() {},
    fetch: async url => { if (url.includes('/ack?')) throw Error('offline'); return ok({ ackRequired: true }) },
  })
  assert.equal((await ackFailure.poll(link)).status, 'ok')
  console.log('ok  Host: old gateway compatibility and failed ACK preserve saved login')

  for (const [response, error] of [[new Response('<html>private response</html>', { status: 520 }), 'gateway-http-520'], [new Response('invalid JSON'), 'malformed'], [new Response('{"status":"ok"}'), 'malformed']]) {
    const bad = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => response,
      readUser: () => null, writeUser: () => { assert.fail('unexpected write') }, onSaved() {} })
    assert.deepEqual(await bad.poll(link), { error })
  }
  const expired = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => new Response('{"status":"expired"}'),
    readUser: () => null, writeUser: () => assert.fail('expired login must not save a token'), onSaved() {} })
  assert.deepEqual(await expired.poll(link), { status: 'expired' })
  const late = deferred()
  const cancelled = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => { await late.promise; return ok() },
    readUser: () => null, writeUser: () => assert.fail('late response must not log the user back in'), onSaved() {} })
  const request = cancelled.poll(link)
  cancelled.reset(); late.resolve()
  assert.deepEqual(await request, { error: 'cancelled' })
  console.log('ok  Host: HTTP and malformed errors are safe; logout invalidates in-flight collection')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(scratch, { recursive: true, force: true })
}

// Small stateful React/timer stand-in: execute the real hook and effects, with
// controllable completion of HTTP calls. No real browser or external network.
let clock = 100_000, nextTimer = 0, bundle, active
const timers = new Map(), storage = new Map()
const setTimer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }
const clearTimer = id => timers.delete(id)
const firePoll = () => {
  const entry = [...timers].find(([, value]) => value.delay === 2500)
  assert.ok(entry, 'next serial poll is scheduled')
  timers.delete(entry[0]); return entry[1].callback()
}
const depsEqual = (left, right) => left?.length === right?.length && left.every((value, index) => value === right[index])
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'fragment',
  useState(initial) {
    const i = active.index++
    if (!(i in active.slots)) active.slots[i] = typeof initial === 'function' ? initial() : initial
    const owner = active
    return [owner.slots[i], value => { owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value }]
  },
  useRef(value) { const i = active.index++; return active.slots[i] ??= { current: value } },
  useCallback(callback, deps) {
    const i = active.index++, previous = active.slots[i]
    if (previous && depsEqual(previous.deps, deps)) return previous.value
    active.slots[i] = { deps, value: callback }; return callback
  },
  useEffect(callback, deps) {
    const i = active.index++, previous = active.slots[i]
    if (previous && depsEqual(previous.deps, deps)) return
    previous?.cleanup?.(); active.slots[i] = { deps, effect: true, cleanup: callback() }
  },
  useMemo: factory => factory(),
}
const messages = { 'eac.pollFailed': 'retry {reason}', 'eac.saveFailed': 'check DSH_HOME permissions', 'eac.done': 'done @{login}' }
const t = key => messages[key] ?? key
let pollCalls = 0, startCalls = 0, reloads = 0
let pollResult = () => new Response('{"error":"gateway-http-520"}', { status: 502 })
const fetch = async url => {
  if (url.includes('/login/start')) { startCalls++; return new Response(JSON.stringify({ link, url: `https://gateway.invalid/eac/auth/github/start?link=${link}`, opened: true })) }
  if (url.includes('/login/poll')) { pollCalls++; return pollResult() }
  return new Response('{"available":true,"authorized":true,"login":"octocat"}')
}
class ClockDate extends Date { static now() { return clock } }
new Function('window', 'document', 'fetch', 'sessionStorage', 'setTimeout', 'clearTimeout', 'Date', fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(
  { __ModuleLoader__: { load: record => { bundle = record } } }, { baseURI: 'http://localhost/' }, fetch,
  { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, setTimer, clearTimer, ClockDate)
const { useEacLogin, EacAuth } = bundle.factory(() => react).__test
const onAuth = () => {}
const mount = () => {
  const owner = { slots: [], index: 0 }
  return {
    render() { active = owner; owner.index = 0; return useEacLogin({ t: key => t(key), summary: { reload: () => { reloads++ } }, onAuth }) },
    unmount() { owner.slots.filter(value => value?.effect).forEach(value => value.cleanup?.()) },
  }
}
let page = mount(), login = page.render()
await login.login(); login = page.render()
await login.login(); assert.equal(startCalls, 1, 'pending login cannot be replaced accidentally')
assert.equal(storage.size, 1)
assert.equal([...storage.values()][0].includes(token), false)
await firePoll(); login = page.render()
assert.equal(login.notice, 'retry HTTP 520')
assert.ok(login.pending)
console.log('ok  UI: HTTP 520 is visible, retries continue and duplicate start is blocked')

page.unmount(); page = mount(); login = page.render()
assert.equal(login.pending.link, link, 'reopening settings restores the same login')
const slow = deferred(); pollResult = () => slow.promise
const running = firePoll(); await flush()
clock += 10_000
assert.equal([...timers.values()].filter(value => value.delay === 2500).length, 0, 'no overlap while the request is unresolved')
// A rerender with a freshly wrapped translator must not reset the poll timer.
login = page.render()
assert.equal([...timers.values()].filter(value => value.delay === 2500).length, 0)
slow.resolve(new Response('{"error":"not-writable"}', { status: 502 })); await running
login = page.render(); assert.equal(login.notice, 'check DSH_HOME permissions')
pollResult = () => new Response('{"status":"ok","login":"octocat"}')
await firePoll(); login = page.render(); await flush()
assert.equal(login.pending, null); assert.equal(login.notice, 'done @octocat')
assert.equal(storage.size, 0); assert.equal(reloads, 1)
console.log('ok  UI: remount resumes; polling stays serial across slow responses/rerenders; persistence error and success are visible')

await login.login(); login = page.render(); login.cancel(); login = page.render()
assert.equal(login.pending, null); assert.equal(storage.size, 0)
await login.login(); login = page.render(); clock += 10 * 60_000
await firePoll(); login = page.render()
assert.equal(login.pending, null); assert.equal(login.notice, 'eac.expired'); assert.equal(storage.size, 0)
await login.login(); login = page.render()
pollResult = () => new Response('{"status":"expired"}')
await firePoll(); login = page.render()
assert.equal(login.pending, null); assert.equal(login.notice, 'eac.sessionExpired'); assert.equal(storage.size, 0)
page.unmount()
const tree = EacAuth({ t, auth: { available: true, unverified: true }, eacLogin: { ...login, pending: null } })
assert.ok(JSON.stringify(tree).includes('eac.pillUnknown'))
assert.equal(JSON.stringify(tree).includes('eac.pillCompat'), false)
console.log('ok  UI: cancel/expiry clear saved links; unknown enforcement is not labeled as compatibility')
console.log('eac-login-test: all checks passed')
