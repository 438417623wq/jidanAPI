/** 复用原渠道页面；只转换加载方式和同源 API 前缀，业务组件保持一致。 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const candidates = ['../packages/standalone/', '../.verify/ui-build/'].map(value => fileURLToPath(new URL(value, import.meta.url)))
const resolved = require.resolve('esbuild', { paths: candidates })
const tooling = path.dirname(path.dirname(path.dirname(resolved)))
const esbuild = await import(pathToFileURL(resolved).href)
let source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error(`共享页面替换位置改变：${from.slice(0, 90)}`)
  source = source.replace(from, to)
}
const anchor = '    exports.apply = apply'
if (source.split(anchor).length !== 2) throw new Error('共享页面导出位置改变')
source = source.replace(anchor, "    exports.standalone = { ChannelsPage, EacAuth, useEacLogin, DICT, CSS, Tank, usePool, poolReading, capacityText, CHANNEL_PROVIDERS, LedgerPage, LogsPage }\n" + anchor)
const api = "try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }"
if (source.split(api).length !== 2) throw new Error('共享页面 API 位置改变')
source = source.replace(api, "return '/api/management'")
replaceOnce("api('/pool', { timeout: 25_000 })", "api('/eac/pool', { timeout: 25_000 })")
// 原页面 POST 空 body；独立管理接口要求 JSON 对象。
replaceOnce("...body === undefined ? {} : { body: JSON.stringify(body) },", "body: JSON.stringify(body ?? {}),")
replaceOnce("h(PageHero, { t, titleKey: 'dash.title', subKey: 'dash.sub' },",
  "h(PageHero, { title: t('dash.title'), sub: t('dash.sub') },")
replaceOnce("'chan.sub': '把各家的免费额度接进来：登录一次，模型就出现在对话框的模型选择器里。凭据只写入本机凭据库，页面永远拿不到明文。',",
  "'chan.sub': '登录各家的账号后，通过同一个 API 地址接入免费额度。凭据保存在本机；账号管理页面不显示明文，导出备份包含凭据。',")
let record
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { record = value } } } })
const shared = record.factory(() => ({})).standalone
const css = shared.CSS + `
.ofm_root{
 --dsw-alias-label-primary:#182b28;--dsw-alias-label-secondary:#586c66;--dsw-alias-label-tertiary:#7a8985;
 --dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f5f7f3;--dsw-alias-bg-layer-3:#eef3eb;
 --dsw-alias-border-l1:#e4e9df;--dsw-alias-border-l2:#d6dfd1;
 --dsw-alias-state-success-primary:#33775d;--dsw-alias-state-error-primary:#bc5348;
 --dsw-alias-state-business-primary:#38624d;
 --dsw-alias-accent-primary:#38624d;--dsw-alias-accent-secondary:#edf3e9;
 max-width:none;
}
.ofm_root button,.ofm_root input,.ofm_root select{font-family:inherit}
.ofm_root img{max-width:100%}
.ofm_root input,.ofm_root select{max-width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:white;color:inherit}
.ofm_root input[type=checkbox]{padding:0}
`
const result = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../packages/standalone/web/channels-entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('../packages/standalone/web/channels.js', import.meta.url)),
  nodePaths: [tooling],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof', write: false,
  plugins: [{
    name: '共享渠道页面',
    setup(build) {
      build.onResolve({ filter: /^ofm-shared-client$/ }, () => ({ path: 'shared-client', namespace: 'ofm' }))
      build.onLoad({ filter: /.*/, namespace: 'ofm' }, () => ({
        contents: `import * as React from 'react'; export const shared = (${record.factory.toString()})(() => React).standalone;`,
        resolveDir: fileURLToPath(new URL('../packages/standalone/', import.meta.url)), loader: 'js',
      }))
    },
  }],
})
const files = [[new URL('../packages/standalone/web/channels.css', import.meta.url), css],
  [new URL('../packages/standalone/web/channels.js', import.meta.url), result.outputFiles[0].text]]
for (const [file, content] of files) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) throw new Error('独立渠道页面需要重新生成')
  } else fs.writeFileSync(file, content)
}
console.log('独立渠道页面生成完成')
