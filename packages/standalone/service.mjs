import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, startForwardServer } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe = false,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const lockFile = path.join(dataDir, 'service.lock')
  const lock = fs.openSync(lockFile, 'wx', 0o600)
  let stores
  let runtime
  let listener
  let timer
  let closing
  let stopped = false
  const releaseLock = () => {
    fs.closeSync(lock)
    fs.unlinkSync(lockFile)
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT }))
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    settings.update({ forwardKey: key })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      // EAC 能力只由插件宿主注入，独立入口不读取任何 DSH 授权状态。
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, eac: false, accountChannels: false, webUi: false },
      }),
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    settings.update({ standalonePort: listener.port })
    settings.flush()

    async function refreshModels(force = false) {
      try { await runtime.refreshCatalog({ probe, force }) }
      catch (error) {
        if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
      } finally {
        if (!stopped && refresh) {
          const minutes = Number(settings.get().probeIntervalMinutes)
          timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
          timer.unref?.()
        }
      }
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = refresh ? refreshModels(probe) : Promise.resolve()
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, ready,
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        runtime.dispose()
        closing = (async () => {
          try { await listener.close() } finally {
            stores.dispose()
            releaseLock()
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    runtime?.dispose()
    if (listener) await listener.close()
    stores?.dispose()
    releaseLock()
    throw error
  }
}
