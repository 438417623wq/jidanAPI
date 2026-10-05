/**
 * GitHub authorization gate for the co-paid lane — self-hosted gateway only.
 *
 * The lane's server side is this gateway, not the relay: the plugin never
 * speaks the relay's auth, it only carries a shared signing secret, so the one
 * place a per-user gate can actually hold is here, in front of the relay key.
 *
 * Flow (browser, same origin as the lane — no nginx change needed, the mount
 * prefix already routes everything under it to this process):
 *
 *   plugin                          gateway                     github
 *     │ POST login/start (link) ──────▶
 *     │                               │ 302 authorize (state = HMAC)
 *     │   (system browser) ───────────┴──────────▶ user signs in
 *     │◀─ poll /auth/poll?link ───────│◀── callback?code ──┤
 *     │                               │ exchange code, GET /user,
 *     │                               │ GET /user/starred/<repo>
 *     │◀─ token (once) ───────────────│ starred ⇒ mint per-user token
 *     │ ── x-ofm-user: token ────────▶│ chat turns are refused without it
 *
 * Storage is `users.json` next to this file (0600, atomic writes): GitHub
 * ids, logins, SHA-256 of issued tokens, star verdicts, and the GitHub OAuth
 * token AES-256-GCM-encrypted under `USER_STORE_KEY` — it is the only way to
 * re-check the star later, and a star that is removed must stop working.
 *
 * Enforcement is `REQUIRE_USER_TOKEN=1`. With the flag off the gate is a
 * compatibility window: tokens are accepted and tracked, nothing is refused.
 * Flipping the flag is the whole cutover — no code change, one restart.
 *
 * @module worker/auth-github.mjs
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_STAR_REPO = 'Ebony-Vinyl/dsh-our-free-model'
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API = 'https://api.github.com'

/** The plugin mints the link code; this is the shape it must arrive in. */
const LINK_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const STATE_TTL_MS = 10 * 60_000
/** How long a completed (or refused) login stays collectable by the plugin. */
const PENDING_TTL_MS = 15 * 60_000
/** A "not starred yet" page keeps this ticket so "recheck" needs no new OAuth. */
const TICKET_TTL_MS = 30 * 60_000
const STORE_VERSION = 1
const AUTH_RATE_PER_MINUTE = 30

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const sha256hex = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const b64url = buffer => Buffer.from(buffer).toString('base64url')

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #e8ecf1; }
  main { max-width: 560px; padding: 40px 32px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 8px 0; color: #b7c0cc; }
  a.btn { display: inline-block; margin-top: 16px; padding: 10px 18px; border-radius: 8px; background: #2f81f7; color: #fff; text-decoration: none; font-weight: 600; }
  a.btn.alt { background: #2b3440; }
  code { background: #1b222b; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`
}

/**
 * Build the gate. Returns a small surface the host wires into its server:
 * `handle` (auth routes), `check` (per-request verdict for chat turns),
 * `stats` (counts for the dashboard) and `close`.
 *
 * @param {object} env - gateway environment (see worker/README.md)
 * @param {{fetchImpl?: Function, log?: Function, storePath?: string, now?: () => number}} [options]
 */
export function createAuthGate(env = {}, options = {}) {
  const log = options.log ?? (message => console.log(message))
  const impl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const storePath = options.storePath ?? env.USER_STORE_PATH ?? path.join(here, 'users.json')
  const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
  const clientId = String(env.GITHUB_CLIENT_ID ?? '').trim()
  const clientSecret = String(env.GITHUB_CLIENT_SECRET ?? '').trim()
  const starRepo = String(env.REQUIRE_STAR_REPO ?? DEFAULT_STAR_REPO).trim() || DEFAULT_STAR_REPO
  const enforcement = String(env.REQUIRE_USER_TOKEN ?? '0') === '1'
  const recheckHours = Math.max(1, Number.parseInt(env.STAR_RECHECK_HOURS ?? '12', 10) || 12)
  const recheckMs = recheckHours * 3_600_000
  const publicOrigin = String(env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '')
  const configured = clientId !== '' && clientSecret !== ''
  // The store key doubles as the state/ticket signing key. A dedicated
  // USER_STORE_KEY is preferred; the lane's signing secret keeps deployments
  // that predate this feature working without a new secret to roll out.
  const keyMaterial = String(env.USER_STORE_KEY ?? '').trim()
    || String(env.SIGNING_SECRETS ?? '').split(',')[0]?.trim()
    || ''
  const keyReady = keyMaterial.length >= 16
  const stateKey = crypto.createHash('sha256').update(`ofm-eac-auth-state\0${keyMaterial}`, 'utf8').digest()

  /** @type {{version: number, users: Record<string, object>}} */
  let store = { version: STORE_VERSION, users: {} }
  /** token sha256 → github id; rebuilt on load and on every mutation. */
  let tokenIndex = new Map()
  /** link → completed login the plugin has not collected yet (memory only). */
  const pending = new Map()
  /** ticket id → {link, login, gh, exp} for the "starred now?" recheck page. */
  const tickets = new Map()
  /** Fixed-window limiter for the auth surface (per IP). */
  const authHits = new Map()

  function rebuildIndex() {
    tokenIndex = new Map()
    for (const [id, user] of Object.entries(store.users)) {
      for (const hash of Object.keys(user.tokens ?? {})) tokenIndex.set(hash, id)
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.users !== null && typeof parsed.users === 'object') {
        store = { version: STORE_VERSION, users: parsed.users }
      }
    } catch { /* absent is the normal first boot; unreadable keeps the empty store */ }
    rebuildIndex()
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true })
      const temp = `${storePath}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(store, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, storePath)
    } catch (error) {
      log(JSON.stringify({ lane: 'eac-auth', fault: `user store write failed: ${String(error?.message ?? error).slice(0, 120)}` }))
    }
  }

  // ── GitHub token at rest ────────────────────────────────────────────────────
  const encKey = crypto.createHash('sha256').update(`ofm-eac-user-store\0${keyMaterial}`, 'utf8').digest()

  function encryptGh(token) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 })
    const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`
  }

  function decryptGh(blob) {
    try {
      const [version, iv, tag, ct] = String(blob ?? '').split('.')
      if (version !== 'v1' || !iv || !tag || !ct) return null
      const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'), { authTagLength: 16 })
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  // ── signed state / ticket ids ──────────────────────────────────────────────
  function signState(payload) {
    const body = b64url(JSON.stringify(payload))
    const mac = crypto.createHmac('sha256', stateKey).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  function verifyState(text) {
    const [body, mac] = String(text ?? '').split('.')
    if (!body || !mac) return null
    const expected = crypto.createHmac('sha256', stateKey).update(body).digest('base64url')
    if (!timingSafeEqual(mac, expected)) return null
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      if (typeof payload?.exp !== 'number' || payload.exp < now()) return null
      return payload
    } catch {
      return null
    }
  }

  // ── GitHub calls ───────────────────────────────────────────────────────────
  const githubHeaders = token => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'eac-gateway',
    'x-github-api-version': '2022-11-28',
  })

  async function exchangeCode(code, redirectUri) {
    const response = await impl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'eac-gateway' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || typeof body?.access_token !== 'string' || body.access_token === '') {
      throw new Error(`github code exchange failed (HTTP ${response.status}${body?.error ? `: ${body.error}` : ''})`)
    }
    return body.access_token
  }

  async function fetchGithubUser(token) {
    const response = await impl(`${GITHUB_API}/user`, { headers: githubHeaders(token), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`github user lookup failed (HTTP ${response.status})`)
    const body = await response.json()
    if (!Number.isFinite(body?.id)) throw new Error('github user lookup returned no id')
    return { id: String(body.id), login: String(body.login ?? ''), avatar: String(body.avatar_url ?? '') }
  }

  /** 204 = starred, 404 = not; 401 is a dead authorization (needs re-login),
   * everything else (403 rate limit, 5xx, network) is transient and must not
   * take access away from a user who may well still be starred. */
  async function checkStar(token) {
    try {
      const response = await impl(`${GITHUB_API}/user/starred/${starRepo}`, { headers: githubHeaders(token), signal: AbortSignal.timeout(10_000) })
      if (response.status === 204) return { starred: true }
      if (response.status === 404) return { starred: false }
      if (response.status === 401) return { fatal: true, error: 'github authorization is no longer valid' }
      return { error: `github answered HTTP ${response.status}` }
    } catch (error) {
      return { error: `github unreachable: ${String(error?.message ?? error).slice(0, 100)}` }
    }
  }

  // ── store mutations ────────────────────────────────────────────────────────
  function mintToken(githubId, user) {
    const token = crypto.randomBytes(32).toString('base64url')
    const hash = sha256hex(token)
    user.tokens = { ...(user.tokens ?? {}), [hash]: { created: now(), lastSeen: now() } }
    store.users[githubId] = user
    rebuildIndex()
    save()
    return token
  }

  function lookup(rawToken) {
    if (typeof rawToken !== 'string' || rawToken === '') return null
    const githubId = tokenIndex.get(sha256hex(rawToken))
    if (githubId === undefined) return null
    const user = store.users[githubId]
    if (user === undefined) return null
    const row = user.tokens[sha256hex(rawToken)]
    if (row !== undefined && row.lastSeen !== undefined) row.lastSeen = now()
    return { githubId, user, tokenHash: sha256hex(rawToken) }
  }

  function revokeToken(rawToken) {
    const found = lookup(rawToken)
    if (found === null) return false
    delete found.user.tokens[found.tokenHash]
    rebuildIndex()
    save()
    return true
  }

  async function recheckUser(githubId, user, { force = false } = {}) {
    if (!force && now() - (user.lastCheck ?? 0) < recheckMs) return
    const gh = decryptGh(user.ghToken)
    if (gh === null) {
      user.lastCheckError = 'stored github authorization is unreadable'
      save()
      return
    }
    const verdict = await checkStar(gh)
    user.lastCheck = now()
    if (verdict.error !== undefined) {
      user.lastCheckError = verdict.error
      if (verdict.fatal === true) {
        // The user revoked the app on GitHub's side: we can never verify the
        // star again, so access ends until they sign in again.
        user.starred = false
        user.revokedReason = 'github authorization revoked'
      }
    } else {
      user.lastCheckError = null
      user.starred = verdict.starred === true
      if (user.starred) delete user.revokedReason
      else user.revokedReason = 'star removed'
    }
    save()
  }

  /** One sweep over users whose verdict is older than the window. Sequential
   * with a small gap — a handful of users per cycle, well inside the API's
   * authenticated quota, and never a burst that looks like abuse. */
  async function recheckAll() {
    for (const [id, user] of Object.entries(store.users)) {
      if (now() - (user.lastCheck ?? 0) < recheckMs) continue
      await recheckUser(id, user)
      await new Promise(resolve => { const t = setTimeout(resolve, 250); t.unref?.() })
    }
  }

  const timer = setInterval(() => { recheckAll().catch(() => {}) }, Math.min(30 * 60_000, Math.max(60_000, Math.floor(recheckMs / 2))))
  timer.unref?.()

  // ── per-request verdict ────────────────────────────────────────────────────
  /**
   * @param {string} rawToken - the `x-ofm-user` header value
   * @returns {{ok: boolean, required: boolean, reason?: string, login?: string, user?: object}}
   */
  function check(rawToken) {
    if (!enforcement) {
      // Compatibility window: nothing is refused, but a presented token is
      // still resolved so the dashboard can tell who is already onboard.
      const found = lookup(rawToken)
      return { ok: true, required: false, user: found?.user ?? null, login: found?.user?.login, githubId: found?.githubId ?? null }
    }
    if (typeof rawToken !== 'string' || rawToken === '') return { ok: false, required: true, reason: 'missing', githubId: null }
    const found = lookup(rawToken)
    if (found === null) return { ok: false, required: true, reason: 'unknown', githubId: null }
    const user = found.user
    if (user.starred !== true) {
      return { ok: false, required: true, reason: 'unstarred', login: user.login, githubId: found.githubId, detail: user.revokedReason ?? user.lastCheckError ?? null }
    }
    // Decide on the stored verdict; a stale one triggers a background refresh
    // rather than a wait, and a failed refresh never takes access away.
    if (now() - (user.lastCheck ?? 0) > recheckMs) void recheckUser(found.githubId, user).catch(() => {})
    return { ok: true, required: true, user, login: user.login, githubId: found.githubId }
  }

  function stats() {
    const users = Object.values(store.users)
    return {
      authorized: users.filter(u => u.starred === true).length,
      known: users.length,
      unstarred: users.filter(u => u.starred !== true).length,
      pending: pending.size,
      required: enforcement,
      configured,
      repo: starRepo,
      recheckHours,
    }
  }

  // ── HTTP surface ───────────────────────────────────────────────────────────
  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const page = (res, status, title, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(htmlPage(title, body))
  }

  const callbackUrl = req => {
    if (publicOrigin !== '') return `${publicOrigin}${prefix}/auth/github/callback`
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim() || 'https'
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()
    return `${proto}://${host}${prefix}/auth/github/callback`
  }

  function rateLimited(req) {
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
    const nowMs = now()
    const row = authHits.get(ip)
    if (row === undefined || nowMs - row.start >= 60_000) {
      if (authHits.size > 5_000) for (const [k, v] of authHits) if (nowMs - v.start >= 60_000) authHits.delete(k)
      authHits.set(ip, { start: nowMs, count: 1 })
      return false
    }
    row.count += 1
    return row.count > AUTH_RATE_PER_MINUTE
  }

  const starLink = () => `https://github.com/${starRepo}`

  function rememberPending(link, entry) {
    pending.set(link, { ...entry, exp: now() + PENDING_TTL_MS })
    for (const [key, value] of pending) if (value.exp < now()) pending.delete(key)
  }

  function grant(link, githubUser, ghToken) {
    const user = store.users[githubUser.id] ?? { created: now(), tokens: {} }
    user.login = githubUser.login
    user.avatar = githubUser.avatar
    user.ghToken = encryptGh(ghToken)
    user.starred = true
    user.lastCheck = now()
    user.lastCheckError = null
    delete user.revokedReason
    const token = mintToken(githubUser.id, user)
    rememberPending(link, { status: 'ok', token, login: githubUser.login, avatar: githubUser.avatar })
    return token
  }

  /**
   * Handle one auth route. Returns true when the request was answered here.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  function handle(req, res, url) {
    const route = url.pathname.startsWith(prefix + '/auth') ? url.pathname.slice(prefix.length) : url.pathname
    if (!route.startsWith('/auth/')) return false
    if (rateLimited(req)) { json(res, 429, { error: { message: 'too many authorization attempts; retry later' } }); return true }

    if (req.method === 'GET' && route === '/auth/poll') {
      const link = url.searchParams.get('link') ?? ''
      if (!LINK_PATTERN.test(link)) return json(res, 400, { error: { message: 'bad link code' } }), true
      const entry = pending.get(link)
      if (entry === undefined || entry.exp < now()) {
        pending.delete(link)
        return json(res, 200, { status: 'pending' }), true
      }
      if (entry.status === 'unstarred') return json(res, 200, { status: 'unstarred', login: entry.login, repo: starRepo }), true
      pending.delete(link) // one-shot: the token is collected exactly once
      return json(res, 200, { status: 'ok', token: entry.token, login: entry.login, avatar: entry.avatar ?? '', repo: starRepo }), true
    }

    if (req.method === 'GET' && route === '/auth/status') {
      const found = lookup(String(req.headers['x-ofm-user'] ?? ''))
      const base = { configured, required: enforcement, repo: starRepo, recheckHours }
      if (found === null) return json(res, 200, { ...base, authorized: false }), true
      const user = found.user
      return json(res, 200, {
        ...base,
        authorized: user.starred === true,
        login: user.login ?? '',
        avatar: user.avatar ?? '',
        starred: user.starred === true,
        lastCheck: user.lastCheck ?? null,
        lastCheckError: user.lastCheckError ?? null,
        reason: user.revokedReason ?? null,
      }), true
    }

    if (req.method === 'POST' && route === '/auth/logout') {
      const token = String(req.headers['x-ofm-user'] ?? '')
      const ok = revokeToken(token)
      return json(res, 200, { ok }), true
    }

    if (req.method === 'GET' && route === '/auth/github/start') {
      if (!configured || !keyReady) {
        return page(res, 503, 'EAC 渠道 · GitHub 登录未就绪',
          `<p>服务器尚未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET），请稍后再试或联系维护者。</p>`), true
      }
      const link = url.searchParams.get('link') ?? ''
      if (!LINK_PATTERN.test(link)) return page(res, 400, '链接无效', '<p>登录链接缺少或格式不正确，请回到插件设置页重新发起登录。</p>'), true
      const state = signState({ link, exp: now() + STATE_TTL_MS })
      const authorize = new URL(GITHUB_AUTHORIZE)
      authorize.searchParams.set('client_id', clientId)
      authorize.searchParams.set('redirect_uri', callbackUrl(req))
      authorize.searchParams.set('scope', 'read:user')
      authorize.searchParams.set('state', state)
      res.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store' })
      return res.end(), true
    }

    if (req.method === 'GET' && route === '/auth/github/callback') {
      const state = verifyState(url.searchParams.get('state'))
      const code = url.searchParams.get('code') ?? ''
      if (state === null || code === '') {
        return page(res, 400, '授权已过期', '<p>这次登录请求已过期或校验失败，请回到插件设置页重新发起登录。</p>'), true
      }
      const link = String(state.link ?? '')
      if (!LINK_PATTERN.test(link)) return page(res, 400, '链接无效', '<p>登录链接格式不正确，请重新发起登录。</p>'), true
      return void (async () => {
        try {
          const ghToken = await exchangeCode(code, callbackUrl(req))
          const githubUser = await fetchGithubUser(ghToken)
          const verdict = await checkStar(ghToken)
          if (verdict.error !== undefined && verdict.fatal !== true) {
            return page(res, 502, 'GitHub 暂时不可用', `<p>无法确认 star 状态（${verdict.error}），请稍后重试。</p>`)
          }
          if (verdict.starred !== true) {
            const ticket = crypto.randomBytes(24).toString('base64url')
            tickets.set(ticket, { link, login: githubUser.login, gh: ghToken, githubId: githubUser.id, avatar: githubUser.avatar, exp: now() + TICKET_TTL_MS })
            rememberPending(link, { status: 'unstarred', login: githubUser.login })
            return page(res, 200, '还差一步：给仓库点个 Star',
              `<p>已用 GitHub 账号 <code>${githubUser.login}</code> 登录成功，但还没有 star 仓库。</p>
               <p>请先点下面的按钮去 star，然后回来点「我已 star，重新检查」——不需要重新登录。</p>
               <a class="btn" href="${starLink()}" target="_blank" rel="noreferrer">⭐ 去 Star</a>
               <a class="btn alt" href="${prefix}/auth/github/recheck?t=${ticket}">我已 star，重新检查</a>`)
          }
          grant(link, githubUser, ghToken)
          return page(res, 200, '✅ 授权成功，请返回应用',
            `<p>GitHub 账号 <code>${githubUser.login}</code> 已登录，且已 star 仓库。</p>
             <p>插件会在几秒内自动完成授权，现在可以关闭这个页面并回到应用。</p>`)
        } catch (error) {
          return page(res, 502, '授权失败', `<p>${String(error?.message ?? error).slice(0, 200)}</p><p>请回到插件设置页重新发起登录。</p>`)
        }
      })(), true
    }

    if (req.method === 'GET' && route === '/auth/github/recheck') {
      const ticket = tickets.get(url.searchParams.get('t') ?? '')
      if (ticket === undefined || ticket.exp < now()) {
        return page(res, 400, '检查链接已过期', '<p>请回到插件设置页重新发起登录。</p>'), true
      }
      return void (async () => {
        const verdict = await checkStar(ticket.gh)
        if (verdict.error !== undefined && verdict.fatal !== true) {
          return page(res, 502, 'GitHub 暂时不可用', `<p>无法确认 star 状态（${verdict.error}），请稍后再试。</p>`)
        }
        if (verdict.starred !== true) {
          return page(res, 200, '还没有检测到 Star',
            `<p>账号 <code>${ticket.login}</code> 的 star 还没生效（GitHub 侧偶尔有几秒延迟）。</p>
             <a class="btn" href="${starLink()}" target="_blank" rel="noreferrer">⭐ 去 Star</a>
             <a class="btn alt" href="${prefix}/auth/github/recheck?t=${url.searchParams.get('t')}">再检查一次</a>`)
        }
        tickets.delete(url.searchParams.get('t'))
        grant(ticket.link, { id: ticket.githubId, login: ticket.login, avatar: ticket.avatar }, ticket.gh)
        return page(res, 200, '✅ 已确认 Star，授权成功',
          `<p>账号 <code>${ticket.login}</code> 已 star 仓库，插件会在几秒内自动完成授权，可以关闭这个页面了。</p>`)
      })(), true
    }

    return json(res, 404, { error: { message: 'not found' } }), true
  }

  load()
  if (enforcement && !configured) {
    log(JSON.stringify({ lane: 'eac-auth', fault: 'REQUIRE_USER_TOKEN=1 but GitHub OAuth is not configured — every chat turn will be refused' }))
  }

  return {
    configured,
    enforcement,
    prefix,
    handle,
    check,
    stats,
    storePath,
    /** Test seam: run one recheck sweep now. */
    recheckAll,
    /** Test seam: force a single user's recheck. */
    recheckUser: (githubId, force = true) => recheckUser(githubId, store.users[githubId], { force }),
    /** Test seam: inspect the store without touching the file. */
    snapshot: () => JSON.parse(JSON.stringify(store)),
    close() { clearInterval(timer) },
  }
}
