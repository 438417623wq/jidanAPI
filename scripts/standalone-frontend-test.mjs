import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildStats } from '../src/core/stats.js'

const web = new URL('../packages/standalone/web/', import.meta.url)
const assets = JSON.parse(fs.readFileSync(new URL('assets.json', web), 'utf8'))
assert.equal(new Set(assets).size, assets.length)
assert.ok(assets.includes('app.js') && assets.includes('app.css'))
assert.ok(assets.every(name => /^[\w-]+\.(js|css)$/.test(name)))
for (const name of assets) assert.ok(fs.statSync(new URL(name, web)).size > 0)
const html = fs.readFileSync(new URL('index.html', web), 'utf8')
assert.match(html, /type="module".+src="\/assets\/app.js"/)
assert.ok(!html.includes('channels-'), '渠道不应在登录首屏预加载')
assert.ok(!html.includes('app.tsx'), '只提供编译后的资源')
assert.ok(!fs.existsSync(new URL('channels.js', web)), '不同时携带第二份 React 渠道包')
const app = fs.readFileSync(new URL('app.js', web), 'utf8')
const channel = assets.find(name => name.startsWith('channels-'))
assert.ok(channel, '渠道必须是独立分包')
assert.ok(app.includes(channel) && app.includes('import('), '入口必须动态导入渠道')
for (const [_, name] of html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) {
  assert.ok(assets.includes(name), `HTML 资源未登记：${name}`)
}
for (const name of assets.filter(name => name.endsWith('.js'))) {
  const source = fs.readFileSync(new URL(name, web), 'utf8')
  for (const [_, dependency] of source.matchAll(/(?:from|import\()\s*["']\.\/([^"']+\.js)["']/g)) {
    assert.ok(assets.includes(dependency), `分包依赖未登记：${dependency}`)
  }
}
const empty = buildStats({}, [])
assert.equal(empty.turns, 0)
assert.equal(empty.requests, 0)
assert.equal(empty.recoveredTurns, 0)
assert.deepEqual(empty.samples, [])
console.log('standalone-frontend: 资源登记、按需分包、单一 React 承载与空统计检查通过')
