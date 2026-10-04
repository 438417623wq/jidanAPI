/**
 * Offline checks for the subscription egress relay (src/egress.js).
 *
 * Everything runs against loopback doubles — a fake socks5 server (both auth
 * and no-auth), a fake HTTP CONNECT proxy, and an echo target — so the suite
 * proves the dialers, header forwarding and stream cadence without touching
 * the network. The managed-mihomo path is covered by config rendering and the
 * binary locator only; spawning the real binary needs a live subscription and
 * belongs to the install-time smoke, not the offline gate.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startEgressRelay, egressFetch, egressActive, renderMihomoConfig, findMihomoBinary, outletLabel, readOutletSelection } from '../src/egress.js'

let checks = 0
let failures = 0

function check(ok, message) {
  checks += 1
  if (!ok) {
    failures += 1
    console.log(`  ✗ ${message}`)
  }
}

/** Echo target: replies with what it saw; /limited answers 429; /stream trickles. */
function startTarget() {
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('A')
      setTimeout(() => { res.write('B'); res.end() }, 150)
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/limited') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
        res.end(JSON.stringify({ error: 'slow down' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
    })
  })
  return listen(server, '127.0.0.1')
}

function listen(server, host) {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)))
}

/** Stand-in for mihomo's external-controller: serves the routes the node
 *  reading uses and remembers the bearer token it was called with. */
function startFakeController(routes) {
  const server = http.createServer((req, res) => {
    server.lastAuth = req.headers.authorization ?? ''
    const body = routes[req.url]
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'not found' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const port = listen(server, '127.0.0.1')
  return port.then(resolved => ({
    port: resolved,
    get lastAuth() { return server.lastAuth ?? '' },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }))
}

/** Read from a socket until the matcher is happy. Dialers are strictly
 *  request/response, so no data can slip between stages. */
function once(socket, matcher) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const onData = chunk => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks, size)
      const mark = matcher(buffer)
      if (mark === null) return
      cleanup()
      resolve({ buffer, rest: buffer.subarray(mark) })
    }
    const onError = error => { cleanup(); reject(error) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

/** A fake socks5 server: negotiates, dials the requested target, splices. */
async function startFakeSocks5({ requireAuth }) {
  const server = net.createServer(socket => {
    void (async () => {
      try {
        const greeting = await once(socket, buffer => (buffer.length < 2 ? null : 2 + buffer[1]))
        console.log('[socks5] greeting:', greeting.buffer, 'rest:', greeting.rest)
        if (greeting.buffer[0] !== 0x05) throw new Error('bad socks version')
        if (requireAuth) {
          if (!greeting.buffer.includes(0x02)) throw new Error('client did not offer auth')
          socket.write(Buffer.from([0x05, 0x02]))
          const auth = await once(socket, buffer => {
            if (buffer.length < 2) return null
            const ulen = buffer[1]
            const plenIndex = 2 + ulen
            if (buffer.length < plenIndex + 1) return null
            const plen = buffer[plenIndex]
            const total = plenIndex + 1 + plen
            return buffer.length >= total ? total : null
          })
          const user = auth.buffer.subarray(2, 2 + auth.buffer[1]).toString('utf8')
          const plenIndex = 2 + auth.buffer[1]
          const pass = auth.buffer.subarray(plenIndex + 1, plenIndex + 1 + auth.buffer[plenIndex]).toString('utf8')
          if (user !== 'u1' || pass !== 'p@ss') throw new Error(`bad creds ${user}/${pass}`)
          socket.write(Buffer.from([0x01, 0x00]))
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
        }
        const head = await once(socket, buffer => {
          if (buffer.length < 5) return null
          if (buffer[3] === 0x01) return buffer.length >= 10 ? 10 : null
          if (buffer[3] === 0x04) return buffer.length >= 22 ? 22 : null
          if (buffer[3] === 0x03) {
            const full = 4 + 1 + buffer[4] + 2
            return buffer.length >= full ? full : null
          }
          throw new Error(`unexpected atyp ${buffer[3]}`)
        })
        const atyp = head.buffer[3]
        console.log('[socks5] connect request: atyp', atyp, 'bytes', head.buffer, 'rest', head.rest)
        let host
        if (atyp === 0x01) host = Array.from(head.buffer.subarray(4, 8)).join('.')
        else if (atyp === 0x04) host = '(v6)'
        else host = head.buffer.subarray(5, 5 + head.buffer[4]).toString('utf8')
        const port = head.buffer.readUInt16BE(head.buffer.length - 2)
        server.lastTarget = { host, port, atyp }
        const upstream = net.connect({ host: '127.0.0.1', port })
        upstream.on('connect', () => {
          console.log('[socks5] upstream connected, sending reply for port', port)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (head.rest.length > 0) upstream.write(head.rest)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.on('error', error => { console.log('[socks5] upstream error:', error.message); socket.destroy() })
      } catch (error) {
        console.log('[socks5] stage failed:', error.message)
        socket.destroy()
      }
    })()
  })
  const port = await listen(server, '127.0.0.1')
  return { port, server }
}

/** A fake HTTP proxy: answers CONNECT, then splices. */
async function startFakeConnect() {
  const server = http.createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, socket, head) => {
    const [host, port] = req.url.split(':')
    const upstream = net.connect({ host, port: Number(port) })
    upstream.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
  })
  return listen(server, '127.0.0.1')
}

let stage = 'boot'
async function main() {
  // 1 — passthrough with no relay: identical to plain fetch.
  stage = 'target'
  const targetPort = await startTarget()
  stage = 'passthrough'
  const base = `http://127.0.0.1:${targetPort}`
  check(egressActive() === false, 'relay starts inactive')
  const direct = await egressFetch(`${base}/direct`, { method: 'POST', body: 'hi', headers: { 'x-keep': 'yes' } })
  const directJson = await direct.json()
  check(direct.status === 200 && directJson.body === 'hi' && directJson.headers['x-keep'] === 'yes', 'passthrough request survives untouched')

  stage = 'render'
  // 2 — config rendering carries the subscription, health-check and group.
  const yaml = renderMihomoConfig({ subscription: 'https://example.com/s/tok', mixedPort: 33001, apiPort: 33002, secret: 'shh', logFile: 'C:/x/m.log' })
  check(yaml.includes('type: http') && yaml.includes('https://example.com/s/tok'), 'provider carries the subscription url')
  check(yaml.includes('expected-status: 204') && yaml.includes('generate_204'), 'health-check prunes non-204 (429) nodes')
  check(yaml.includes('type: url-test') && yaml.includes('- MATCH,ofm-outlet'), 'group is url-test and rules route through it')
  check(yaml.includes('mixed-port: 33001') && yaml.includes('external-controller: 127.0.0.1:33002'), 'ports land in the config')
  // Confinement: this outlet serves the plugin's own opencode traffic only. It
  // must never listen off-loopback, never register a system proxy, never take
  // over routing via TUN.
  check(yaml.includes('bind-address: 127.0.0.1'), 'listener is bound to loopback')
  check(yaml.includes('allow-lan: false'), 'lan access stays off')
  check(!yaml.includes('tun:') && !yaml.includes('enable: true\n  auto-detect'), 'no tun section, no system-proxy takeover')

  stage = 'validation'
  // 3 — locator and validation failures are immediate, actionable errors.
  try {
    const found = findMihomoBinary('')
    check(found.length > 0, 'mihomo discovery either finds a binary or explains itself')
  } catch (error) {
    check(String(error.message).includes('no mihomo binary'), 'mihomo discovery either finds a binary or explains itself')
  }
  try {
    findMihomoBinary('C:/definitely/not/here.exe')
    check(false, 'explicit missing binary throws')
  } catch (error) {
    check(String(error.message).includes('does not exist'), 'explicit missing binary throws')
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-egress-'))
  try {
    await startEgressRelay({ config: () => ({ mode: 'client', url: '' }), dataDir })
    check(false, 'empty url throws')
  } catch (error) {
    check(String(error.message).includes('empty'), 'empty url throws')
  }
  try {
    await startEgressRelay({ config: () => ({ mode: 'client', url: 'ftp://x' }), dataDir })
    check(false, 'unsupported scheme throws')
  } catch (error) {
    check(String(error.message).includes('unsupported proxy scheme'), 'unsupported scheme throws')
  }

  stage = 'socks5-auth start'
  // 4 — socks5 with credentials; the target header must stop at the relay.
  const socks5a = await startFakeSocks5({ requireAuth: true })
  stage = 'socks5-auth relay start'
  let relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `socks5://u1:p%40ss@127.0.0.1:${socks5a.port}` }), dataDir, log: message => console.log('[relay]', message) })
  stage = 'socks5-auth fetch'
  check(egressActive() === true, 'relay activates')
  try {
    await egressFetch('file:///etc/passwd')
    check(false, 'non-http target rejected while relay active')
  } catch (error) {
    check(String(error.message).includes('http(s) targets'), 'non-http target rejected while relay active')
  }
  const echo = await egressFetch(`${base}/v1/chat/completions?stream=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model: 'free' }),
  })
  const echoJson = await echo.json().catch(() => ({}))
  check(echo.status === 200, `relay echo responds 200 (got ${echo.status}: ${JSON.stringify(echoJson).slice(0, 200)})`)
  check(echoJson.method === 'POST' && echoJson.url === '/v1/chat/completions?stream=1', 'path and method cross the relay')
  check(echoJson.body === '{"model":"free"}' && echoJson.headers?.['content-type'] === 'application/json', 'body and headers cross the relay')
  check(echoJson.headers?.authorization === 'Bearer sk-test', 'authorization header is forwarded verbatim')
  check(echoJson.headers?.['x-ofm-egress-target'] === undefined, 'the target header stops at the relay')
  check(socks5a.server.lastTarget.host === '127.0.0.1' && socks5a.server.lastTarget.port === targetPort, 'socks5 dialed the real target')

  // 5 — 429 and its retry-after are responses, not errors.
  stage = 'socks5-auth 429'
  const limited = await egressFetch(`${base}/limited`)
  check(limited.status === 429 && limited.headers.get('retry-after') === '7', '429 with retry-after passes through intact')

  // 6 — stream cadence: the second chunk arrives after the relay, not with the first.
  stage = 'socks5-auth stream'
  const stream = await egressFetch(`${base}/stream`)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  const t1 = Date.now()
  const second = await reader.read()
  const gap = Date.now() - t1
  check(decoder.decode(first.value) === 'A', 'first stream chunk arrives on its own')
  check(decoder.decode(second.value) === 'B', 'second stream chunk follows')
  check(gap >= 80, `chunks keep their cadence through the relay (gap ${gap}ms >= 80ms)`)
  await reader.cancel().catch(() => {})
  // 7 — a loopback request without the target header is refused, not proxied.
  // Checked while the relay is still up: undici pools connections per origin,
  // so a raw fetch at a just-closed port would hit a stale pooled socket.
  stage = 'bare fetch'
  const bare = await fetch(`http://127.0.0.1:${relay.port}/anything`)
  check(bare.status === 400, 'relay refuses requests without a target header')
  stage = 'socks5-auth close'
  await relay.close()
  check(egressActive() === false, 'close deactivates the relay')

  // 8 — socks5h: hostname goes to the proxy (atyp 3), not a local lookup.
  stage = 'socks5h start'
  const socks5b = await startFakeSocks5({ requireAuth: false })
  relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `socks5h://127.0.0.1:${socks5b.port}` }), dataDir, log: message => console.log('[relay8]', message) })
  stage = 'socks5h fetch'
  const viaSocksH = await egressFetch(`${base}/h`)
  check(viaSocksH.status === 200, 'socks5h outlet serves the request')
  check(socks5b.server.lastTarget?.atyp === 0x03, 'socks5h sends the hostname to the proxy')
  stage = 'socks5h close'
  await relay.close()

  // 9 — HTTP CONNECT outlet.
  stage = 'connect start'
  const connectPort = await startFakeConnect()
  relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `http://127.0.0.1:${connectPort}` }), dataDir, log: message => console.log('[relay9]', message) })
  stage = 'connect fetch'
  const viaConnect = await egressFetch(`${base}/connect-ok`, { method: 'PUT', body: 'payload' })
  const connectJson = await viaConnect.json()
  check(viaConnect.status === 200 && connectJson.method === 'PUT' && connectJson.body === 'payload', 'HTTP CONNECT outlet carries the request')
  await relay.close()

  // 10 — subscription mode with an explicit bad binary path fails before spawn.
  stage = 'subscription bad binary'
  try {
    await startEgressRelay({ config: () => ({ mode: 'subscription', url: 'https://example.com/s/tok', mihomoPath: 'C:/missing/mihomo.exe' }), dataDir })
    check(false, 'subscription mode surfaces a missing binary')
  } catch (error) {
    check(String(error.message).includes('does not exist'), 'subscription mode surfaces a missing binary')
  }

  // 11 — outletLabel shows the host, never the credential path.
  stage = 'label'
  check(outletLabel('https://dy2.ssydy.com/s/SECRET') === 'https://dy2.ssydy.com', 'subscription label masks the path')

  // 12 — the settings page's node reading, against a fake mihomo controller.
  stage = 'outlet selection'
  check(await readOutletSelection(null) === null, 'no outlet means no reading')
  check(await readOutletSelection({}) === null, 'an unmanaged relay has no controller to ask')
  // Provider nodes are not addressable as /proxies/<name>, so the ranked delay has
  // to come out of the provider table — this is the shape a live mihomo serves.
  const controller = await startFakeController({
    '/proxies/ofm-outlet': { now: 'JP 5', type: 'URLTest', history: [] },
    '/providers/proxies/egress': { proxies: [{ name: 'JP 5', history: [{ time: 'now', delay: 294 }] }, { name: 'JP 4', history: [{ delay: 380 }] }] },
  })
  const relayStub = { managed: { mixedPort: 1, apiPort: controller.port, secret: 'shh', dir: dataDir } }
  const selection = await readOutletSelection(relayStub)
  check(selection?.node === 'JP 5', 'the group now-choice is read as the node')
  check(selection?.delayMs === 294, 'the delay comes from the provider row of that node')
  check(controller.lastAuth === 'Bearer shh', 'the controller is called with the bearer secret')
  await controller.close()
  let controllerThrew = false
  try { await readOutletSelection(relayStub) } catch { controllerThrew = true }
  check(controllerThrew, 'a controller that stopped answering raises, so the caller keeps the last reading')
  // A node url-test just picked has no row yet, or no test logged: the name is
  // still worth showing, the delay simply is not known.
  const fresh = await startFakeController({
    '/proxies/ofm-outlet': { now: 'SG 1', history: [] },
    '/providers/proxies/egress': { proxies: [{ name: 'SG 2', history: [{ delay: 120 }] }] },
  })
  const unranked = await readOutletSelection({ managed: { mixedPort: 1, apiPort: fresh.port, secret: 'shh', dir: dataDir } })
  check(unranked?.node === 'SG 1' && unranked?.delayMs === 0, 'a node without a delay yet is still reported by name')
  await fresh.close()
  // Builds that keep the reading on the group instead: the group history is the fallback.
  const grouped = await startFakeController({ '/proxies/ofm-outlet': { now: 'HK 1', history: [{ delay: 210 }] } })
  const fallback = await readOutletSelection({ managed: { mixedPort: 1, apiPort: grouped.port, secret: 'shh', dir: dataDir } })
  check(fallback?.node === 'HK 1' && fallback?.delayMs === 210, 'the group history is used when the provider table has no row')
  await grouped.close()

  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: egress ${checks - failures}/${checks} checks`)
  // The fake listeners (target, socks5, CONNECT) are still open; exit directly.
  process.exit(failures > 0 ? 1 : 0)
}

await main().catch(error => {
  console.error(`FATAL at stage "${stage}":`, error)
  process.exit(1)
})
