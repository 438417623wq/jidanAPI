import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildStats } from '../src/core/stats.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'

const web = new URL('../packages/standalone/web/', import.meta.url)
const assets = JSON.parse(fs.readFileSync(new URL('assets.json', web), 'utf8'))
assert.equal(new Set(assets).size, assets.length)
assert.ok(assets.includes('app.js') && assets.includes('app.css'))
assert.ok(assets.every(name => /^[\w-]+\.(js|css)$/.test(name)))
for (const name of assets) assert.ok(fs.statSync(new URL(name, web)).size > 0)
const html = fs.readFileSync(new URL('index.html', web), 'utf8')
assert.match(html, /type="module".+src="\/assets\/app.js"/)
assert.ok(!html.includes('channels-'), '渠道不应在登录首屏预加载')
assert.ok(!html.includes('models-'), '模型页面不应在登录首屏预加载')
assert.ok(!html.includes('app.tsx'), '只提供编译后的资源')
assert.ok(!fs.existsSync(new URL('channels.js', web)), '不同时携带第二份 React 渠道包')
const app = fs.readFileSync(new URL('app.js', web), 'utf8')
const channel = assets.find(name => name.startsWith('channels-'))
assert.ok(channel, '渠道必须是独立分包')
assert.ok(app.includes(channel) && app.includes('import('), '入口必须动态导入渠道')
const modelsChunk = assets.find(name => name.startsWith('models-'))
assert.ok(modelsChunk && app.includes(modelsChunk), '入口必须按需导入模型页面')
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
const catalog = Array.from({ length: 1000 }, (_, index) => ({
  id: `provider/model-${index}`, name: `测试模型 ${index}`, channel: index % 2 ? 'buddy' : 'kilo',
  vision: index % 3 === 0, reasoning: index % 5 === 0, routable: index % 7 !== 0,
  availability: index % 2 ? 'listed' : 'available',
}))
const baseline = structuredClone(catalog)
assert.equal(filterModels(catalog, {}).length, 1000)
assert.equal(filterModels(catalog, { search: '  PROVIDER/MODEL-999  ' })[0].id, catalog[999].id)
assert.equal(filterModels(catalog, { search: '测试模型 999' }).length, 1)
assert.equal(filterModels(catalog, { channel: 'eac' }).length, 0)
assert.ok(filterModels(catalog, { capability: 'text' }).every(model => !model.vision))
const combined = filterModels(catalog, { channel: 'buddy', capability: 'reasoning', availability: 'listed', access: 'routable' })
assert.ok(combined.length > 0)
assert.ok(combined.every(model => model.channel === 'buddy' && model.reasoning && model.routable && model.availability === 'listed'))
assert.equal(filterModels(catalog, { channel: 'buddy', availability: 'available' }).length, 0)
assert.equal(filterModels(catalog, { access: 'hidden' }).length + filterModels(catalog, { access: 'routable' }).length, catalog.length)
assert.equal(filterModels([{ id: 'unknown', name: '未知状态', routable: false }], { availability: 'unknown' }).length, 1)
assert.deepEqual(catalog, baseline, '视图筛选不得改变目录、公开状态或模型开关')
console.log('standalone-frontend: 资源登记、双页面分包、空统计与千模型组合筛选检查通过')
