/**
 * Tests for the plugin's request trust fence (src/trust.js).
 *
 * The plugin's prefix outranks the kernel's `/api` in webServer dispatch, so
 * these checks are what stands between the settings API and a cross-site or
 * DNS-rebinding caller whenever the composition offers no connection service.
 *
 * Run: node scripts/trust-test.mjs
 */
import assert from 'node:assert/strict'
import { rejectionFor, structuralRejection } from '../src/trust.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const req = headers => ({ headers })

// ── the structural fence ─────────────────────────────────────────────────────
check('same-origin loopback request passes', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080' })), undefined)
  assert.equal(structuralRejection(req({ host: 'localhost:8080' })), undefined)
  assert.equal(structuralRejection(req({ host: '[::1]:8080' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', referer: 'http://127.0.0.1:8080/settings' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', 'sec-fetch-site': 'same-origin' })), undefined)
})
check('a Host that is not loopback is refused (DNS rebinding)', () => {
  assert.equal(structuralRejection(req({ host: 'evil.example:8080' })), 403)
  assert.equal(structuralRejection(req({})), 403)
})
check('cross-site fetches are refused', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' })), 403)
})
check('mismatched Origin/Referer authority is refused', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9999' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', origin: 'http://evil.example:8080' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', referer: 'https://127.0.0.1:8080/x' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', origin: 'null' })), 403)
})
check('non-http Origin schemes are refused', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', origin: 'file:///etc/passwd' })), 403)
})
check('the desktop relay Referer passes only without browser markers', () => {
  for (const referer of ['dsh-app://app/', 'dsh-app://app/settings']) {
    assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', referer })), undefined)
    for (const markers of [
      { origin: 'http://127.0.0.1:8080' },
      { origin: 'dsh-app://app' },
      { origin: 'null' },
      { origin: '' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': '' },
    ]) assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', referer, ...markers })), 403)
  }
})
check('a desktop Referer cannot override the loopback Host fence', () => {
  for (const host of ['evil.example:8080', '192.168.1.2:8080', undefined]) {
    assert.equal(structuralRejection(req({ host, referer: 'dsh-app://app/' })), 403)
  }
})
check('other desktop pages, credentials and ports are refused', () => {
  for (const referer of [
    'dsh-app://shell/', 'dsh-app://app.evil/', 'dsh-app://evil@app/',
    'dsh-app://user:secret@app/', 'dsh-app://app:8080/', 'file:///app/',
  ]) assert.equal(structuralRejection(req({ host: '127.0.0.1:8080', referer })), 403)
})

// ── the connection-service bridge ────────────────────────────────────────────
check('a mounted connection service decides', () => {
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), { admit: () => ({ peer: {} }) }), undefined)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), { admit: () => ({ rejection: 401 }) }), 401)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), { admit: () => ({ rejection: 403 }) }), 403)
})
check('a throwing connection service never bypasses Host authentication', () => {
  const connection = { admit: () => { throw new Error('bug') } }
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), connection), 503)
  assert.equal(rejectionFor(req({ host: 'evil.example' }), connection), 503)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080', referer: 'dsh-app://app/' }), connection), 503)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), {
    get admit() { throw new Error('service lookup failed') },
  }), 503)
})
check('no connection service means fence only', () => {
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), undefined), undefined)
  assert.equal(rejectionFor(req({ host: 'evil.example' }), undefined), 403)
})
check('a desktop request still respects Host 401/403', () => {
  const desktop = req({ host: '127.0.0.1:8080', referer: 'dsh-app://app/' })
  for (const rejection of [401, 403]) {
    assert.equal(rejectionFor(desktop, { admit: () => ({ rejection }) }), rejection)
  }
})
check('rejection diagnostics contain fixed reason fields only', () => {
  const decisions = []
  const record = decision => decisions.push(decision)
  const request = req({
    host: '127.0.0.1:8080', origin: 'https://evil.example/?token=private',
    referer: 'https://user:password@evil.example/', cookie: 'cookie-secret', authorization: 'Bearer auth-secret',
  })
  assert.equal(rejectionFor(request, undefined, record), 403)
  assert.equal(rejectionFor(request, { admit: () => ({ rejection: 401 }) }, record), 401)
  assert.equal(rejectionFor(request, { admit: () => { throw new Error('exception-secret') } }, record), 503)
  assert.deepEqual(decisions, [
    { status: 403, source: 'structural', reason: 'origin-mismatch' },
    { status: 401, source: 'connection', reason: 'host-rejected' },
    { status: 503, source: 'connection', reason: 'admission-error' },
  ])
  assert.equal(rejectionFor(req({ host: 'localhost:8080' }), undefined, record), undefined)
  assert.equal(decisions.length, 3, 'successful requests do not emit diagnostics')
})
check('a diagnostic callback failure cannot change the rejection', () => {
  const brokenLog = () => { throw new Error('logger failed') }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), undefined, brokenLog), 403)
  assert.equal(rejectionFor(req({ host: 'localhost' }), { admit: () => ({ rejection: 401 }) }, brokenLog), 401)
  assert.equal(rejectionFor(req({ host: 'localhost' }), { admit: () => { throw new Error('service failed') } }, brokenLog), 503)
})

// What the plugin hands the fence is not the service but a view of it, because
// the composition may publish `connection` long after plugins have loaded — and
// reading it once at apply time froze in "absent" for the life of the process.
// The shape is only safe if a getter with nothing behind it answers `undefined`
// rather than a silent `admit`: an `admit` that exists but says nothing reads to
// trust.js as "admitted", which would switch the fence off entirely.
check('the plugin’s late-binding fence view is not a pass', () => {
  const view = service => ({ get admit() { return service === undefined ? undefined : (req => service.admit(req)) } })
  assert.equal(rejectionFor(req({ host: 'evil.example' }), view(undefined)), 403)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8080' }), view(undefined)), undefined)
})
check('and it consults the service from the moment it appears', () => {
  let service
  const view = { get admit() { return service === undefined ? undefined : (req => service.admit(req)) } }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), view), 403)
  service = { admit: () => ({ rejection: 401 }) }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), view), 401)
})

if (failures === 0) console.log('trust-test: OK')
else { console.error(`trust-test: ${failures} failure(s)`); process.exit(1) }
