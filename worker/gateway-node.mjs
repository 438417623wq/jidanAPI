#!/usr/bin/env node
/**
 * Node host for the EAC gateway — the self-hosted form of worker/worker.js
 * (宝塔/PM2/systemd 都跑这个文件；Cloudflare 部署则直接用 worker.js)。
 *
 * The validation core is the SAME module Cloudflare runs: this shim only
 * adapts Node's HTTP server to the Web `fetch(request, env, ctx)` contract,
 * so a signed request is validated identically on either host.
 *
 * Configuration — environment variables, or a sibling `.env` file
 * (`KEY=VALUE` lines, `#` comments; real env vars win over `.env`):
 *
 *   UPSTREAM_URL         the relay base, https (or http to a loopback host)
 *   UPSTREAM_API_KEY     the relay credential — lives HERE only
 *   SIGNING_SECRETS      comma-separated accepted signing secrets
 *   MODELS               optional comma-separated model allowlist
 *   CLOCK_SKEW_SECONDS   optional replay window (default 600)
 *   MAX_BODY_BYTES       optional request body cap (default 8 MiB)
 *   MOUNT_PREFIX         optional sub-path mount (e.g. "/eac" serving the lane
 *                        at /eac/v1/... under a site that already exists; the
 *                        signature covers the full pathname)
 *   HOST                 bind address, default 127.0.0.1 — keep it behind a
 *                        reverse proxy (Nginx); binding a public interface
 *                        would also make the X-Forwarded-For IP below spoofable
 *   PORT                 default 17788
 *   RATE_LIMIT_PER_MINUTE  per-IP fixed-window limit, default 60, 0 = off
 *                        (in-process; exact here because one process = one counter)
 *
 * Run: node gateway-node.mjs   (starts listening; Ctrl-C stops)
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import gateway from './worker.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Fill unset variables from a sibling `.env`, if present. */
function loadDotEnv(target) {
  const file = path.join(here, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (target[key] === undefined || target[key] === '') target[key] = value
  }
}

/** In-process fixed-window per-IP limiter — the Worker's RATE_LIMITER binding
 * has no Node equivalent, and one process owning one counter is exact here. */
function buildRateLimiter(perMinute) {
  if (!Number.isFinite(perMinute) || perMinute <= 0) return undefined
  const seen = new Map()
  return {
    async limit({ key }) {
      const window = Math.floor(Date.now() / 60_000)
      const row = seen.get(key)
      if (row === undefined || row.window !== window) {
        if (seen.size > 10_000) for (const [k, v] of seen) if (v.window !== window) seen.delete(k)
        seen.set(key, { window, count: 1 })
        return { success: true }
      }
      row.count += 1
      return { success: row.count <= perMinute }
    },
  }
}

/**
 * Build the host server around the shared gateway core. Exported so the
 * offline suite can drive the exact process a deployment would run.
 *
 * @param {object} hostEnv - the environment (see the module note)
 * @returns {http.Server}
 */
export function createGatewayServer(hostEnv = {}) {
  const env = { ...hostEnv }
  loadDotEnv(env)

  const maxBody = Number.parseInt(env.MAX_BODY_BYTES ?? '8388608', 10) || 8388608
  const perMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? '60', 10)
  const limiter = buildRateLimiter(perMinute)

  const tooLarge = () => new Response(JSON.stringify({ error: { message: 'request body too large' } }), {
    status: 413, headers: { 'content-type': 'application/json; charset=utf-8' },
  })

  return http.createServer((req, res) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBody) { overflow = true; chunks.length = 0; return }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      if (overflow) {
        const rejected = tooLarge()
        res.writeHead(rejected.status, { 'content-type': rejected.headers.get('content-type') })
        res.end(await rejected.text())
        return
      }
      try {
        // The gateway counts rate-limit keys off `cf-connecting-ip`; behind the
        // reverse proxy the client IP arrives on X-Forwarded-For. Trusting that
        // header is safe only while HOST stays loopback (see the module note).
        const headers = new Headers(req.headers)
        const forwarded = req.headers['x-forwarded-for']
        if (typeof forwarded === 'string' && forwarded !== '') headers.set('cf-connecting-ip', forwarded.split(',')[0].trim())
        const request = new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: req.method === 'POST' || req.method === 'PUT' ? Buffer.concat(chunks).toString('utf8') : undefined,
        })
        const response = await gateway.fetch(request, { ...env, RATE_LIMITER: env.RATE_LIMITER ?? limiter }, { waitUntil() {}, passThroughOnException() {} })
        const out = {}
        response.headers.forEach((value, name) => { out[name] = value })
        res.writeHead(response.status, out)
        if (response.body === null) { res.end(); return }
        Readable.fromWeb(response.body).pipe(res)
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: 'gateway request failed' } }))
        console.log(JSON.stringify({ lane: 'eac-node', fault: String(error?.message ?? error).slice(0, 160) }))
      }
    })
    req.on('error', () => res.destroy())
  })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = { ...process.env }
  loadDotEnv(env)
  const host = env.HOST || '127.0.0.1'
  const port = Number.parseInt(env.PORT ?? '17788', 10) || 17788
  createGatewayServer(env).listen(port, host, () => {
    console.log(`eac gateway listening on ${host}:${port} → ${String(env.UPSTREAM_URL ?? '(UPSTREAM_URL not set)')}`)
  })
}
