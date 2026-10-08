/** 仅测试进程通过 --import 装载：真实渠道请求重定向至本机替身。 */
import { lane } from '../../src/eac.js'

const original = globalThis.fetch
const fixture = process.env.OFM_TEST_UPSTREAM
if (!fixture || new URL(fixture).hostname !== '127.0.0.1') throw new Error('渠道替身必须是本机 HTTP 服务')
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return original(input, options)
  if (url.protocol !== 'https:') throw new Error('测试禁止外部网络')
  const headers = new Headers(options.headers)
  headers.set('x-ofm-fixture-host', url.hostname)
  return original(`${fixture}/remote${url.pathname}${url.search}`, { ...options, headers, redirect: 'manual' })
}
lane.fetch = globalThis.fetch
