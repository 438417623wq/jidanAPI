/**
 * 真实上游长思考探测：分别记录原请求结束、自动恢复和最终截断。
 *
 * issue #10 修正了无结束帧的 EOF 被当成 stop；issue #12 在只有思考、
 * 没有正文或工具调用时，默认允许一次检查点新请求。它不是原生 resume。
 *
 * 默认使用恢复实现；--recovery off 可对照不恢复的行为。已有内容的
 * 截断代码是 STREAM_CUT，完全无输出才可能是可重试的 TRANSPORT，
 * 不能只统计 TRANSPORT，也不能把恢复成功算作原请求正常结束。
 *
 * 脚本会访问真实上游并消耗额度；不输出提示词、思考原文或检查点。
 * 一次没有截断的请求不能证明恢复成功，也不能否定截断检测。
 *
 * 运行：node scripts/probes/long-think-truncation.mjs
 *       [--model id] [--runs N] [--effort deep] [--recovery on|off]
 */

import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../../src/adapter.js'
import { capabilitiesFor } from '../../src/catalog.js'
import { wireFor } from '../../src/upstream.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const MODEL = arg('model', 'mimo-v2.6-flash-free')
const RUNS = Number(arg('runs', 1))
const EFFORT = arg('effort', 'deep')
const RECOVERY = arg('recovery', 'on')
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('--runs must be a positive integer')
if (RECOVERY !== 'on' && RECOVERY !== 'off') throw new Error('--recovery must be on or off')

/**
 * 原请求不给真实工具，并要求长思考；能否到达上游截断仍需实际观测。
 */
const PROMPT = 'Without counting on any tool, reason at length and carefully about whether a sorting algorithm that is O(n log n) comparisons on average can also be O(n) worst case, examining three constructions and every place the argument breaks. Do not write the conclusion until the analysis is finished, and write out the full analysis before answering.'

const caps = capabilitiesFor(MODEL)
const CATALOG = [{
  id: MODEL, name: MODEL, availability: 'available', vision: caps.vision === true,
  reasoning: caps.reasoning !== false, contextWindow: caps.contextWindow,
  maxOutput: caps.maxOutput, canDisableThinking: caps.canDisableThinking !== false,
}]
let physicalRecords = []

const adapter = new FreeModelAdapter({
  state: () => ({
    catalog: CATALOG,
    membership: { [ROUTE_MAIN]: [MODEL], [ROUTE_REGION]: [] },
    settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: RECOVERY !== 'off' },
    attributionUserAgent: 'probe/1.0',
  }),
  recordUsage: record => {
    physicalRecords.push(record)
    console.log(`  record        : attempt=${record.attempt ?? 0} recoveryAttempt=${record.recoveryAttempt === true} scheduled=${record.recoveryScheduled === true} recovered=${record.recovered === true} ok=${record.ok} input=${record.input} output=${record.output} reasoning=${record.reasoning} truncated=${record.truncated === true} noUsage=${record.noUsage === true}`)
  },
  warn: message => console.log(`  warn          : ${message}`),
})

console.log(`model=${MODEL} wire=${wireFor(MODEL)} effort=${EFFORT} recovery=${RECOVERY} runs=${RUNS}`)
let cut = 0
let clean = 0
let ceiling = 0
let recoveryAttempts = 0
let recovered = 0
let recoveryFailed = 0
let physicalTotal = 0
for (let run = 1; run <= RUNS; run += 1) {
  physicalRecords = []
  const started = Date.now()
  let reasoningChars = 0
  let textChars = 0
  let firstDeltaAt = 0
  let finish = null
  let logicalUsage
  let lastFrameAt = started
  console.log(`\n--- run ${run} ---`)
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model: MODEL,
    sessionId: `probe:long-think:${run}:${Date.now()}`,
    reasoningEffort: EFFORT,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })) {
    if (chunk.type === 'reasoning-delta') { if (firstDeltaAt === 0) firstDeltaAt = Date.now(); reasoningChars += chunk.text.length; lastFrameAt = Date.now() }
    else if (chunk.type === 'text-delta') { if (firstDeltaAt === 0) firstDeltaAt = Date.now(); textChars += chunk.text.length; lastFrameAt = Date.now() }
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'usage') logicalUsage = chunk.usage
  }
  const elapsed = Date.now() - started
  const kind = finish?.kind ?? 'none'
  const code = finish?.failure?.code ?? ''
  const attempted = physicalRecords.some(record => record.recoveryAttempt === true || record.attempt === 1)
  const recoverySucceeded = attempted && kind === 'stop' && physicalRecords.some(record => record.recovered === true)
  const usageMissing = physicalRecords.some(record => record.noUsage === true)
  const wasCut = kind === 'error' && (code === 'STREAM_CUT' || code === 'TRANSPORT')
  const verdict = recoverySucceeded ? 'RECOVERED (checkpoint request completed the answer)'
    : attempted ? `RECOVERY FAILED (${kind}, ${code || 'no failure code'})`
      : wasCut ? `CUT (${code === 'STREAM_CUT' ? 'not resent by the harness' : 'no output, retryable failure'})`
    : kind === 'max-tokens' ? 'CEILING (output budget reached, not a cut)'
      : kind === 'stop' ? 'CLEAN (reached its finish token)' : `OTHER (${kind})`
  if (attempted) recoveryAttempts++
  if (recoverySucceeded) recovered++
  else if (attempted) recoveryFailed++
  else if (wasCut) cut++
  else if (kind === 'stop') clean++
  else if (kind === 'max-tokens') ceiling++
  physicalTotal += physicalRecords.length
  console.log(`  wall          : ${(elapsed / 1000).toFixed(1)}s  first delta +${firstDeltaAt === 0 ? '-' : ((firstDeltaAt - started) / 1000).toFixed(1)}s  last frame ${(lastFrameAt === started ? 0 : (lastFrameAt - started) / 1000).toFixed(1)}s`)
  console.log(`  output        : reasoning ${reasoningChars} chars, text ${textChars} chars`)
  console.log(`  requests      : ${physicalRecords.length} physical, recoveryAttempted=${attempted}, recovered=${recoverySucceeded}`)
  console.log(`  known usage   : ${JSON.stringify(logicalUsage ?? null)} missingSegmentUsage=${usageMissing}`)
  console.log(`  finish        : ${JSON.stringify(finish)}`)
  console.log(`  verdict       : ${verdict}`)
}
console.log(`\nsummary: ${physicalTotal} physical requests, ${clean} clean originals, ${ceiling} at the output ceiling, ${cut} unrecovered cuts, ${recoveryAttempts} recovery attempts (${recovered} succeeded, ${recoveryFailed} failed)`)
console.log('note: a clean original is not a recovery test. Live cuts depend on the upstream; use the offline recovery and truncation suites for controlled EOF cases. Known usage is incomplete whenever missingSegmentUsage=true.')
