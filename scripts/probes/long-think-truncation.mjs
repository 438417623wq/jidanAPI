/**
 * Can this lane still be cut mid-stream, and does the cut now read as a failure?
 *
 * Issue #10's report: a long thinking round with no tool calls ends silently,
 * because the gateway closes the SSE body without a finish token, without a usage
 * frame, and without `data: [DONE]`. The plugin used to fall through
 * `finishReason(undefined)` → `stop`, so the harness marked the turn completed.
 *
 * This drives the real adapter against the real gateway on the model and effort the
 * report names, and prints what the tail of the stream actually was:
 *
 *   - terminal frame present + `stop`     → the model finished; nothing to catch.
 *   - terminal frame present + `length`   → the ceiling cut it, which is a
 *                                           different (already handled) failure.
 *   - `TRANSPORT` with "before its finish
 *     token"                              → the cut was reproduced, and it is now
 *                                           reported instead of swallowed.
 *
 * A single run is not proof either way: the gateway cut these unpredictably for
 * the reporter. Repeat with `--runs N`.
 *
 * Run: node scripts/probes/long-think-truncation.mjs [--model id] [--runs N]
 */

import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../../src/adapter.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const MODEL = arg('model', 'mimo-v2.6-flash-free')
const RUNS = Number(arg('runs', 1))
const EFFORT = arg('effort', 'deep')

/**
 * A prompt with no tool available and no short answer: the reported shape was a
 * turn whose only output was a reasoning block, so nothing is allowed to end the
 * turn early — no tool call, and no visible prose until the thinking is done.
 */
const PROMPT = 'Without counting on any tool, reason at length and carefully about whether a sorting algorithm that is O(n log n) comparisons on average can also be O(n) worst case, examining three constructions and every place the argument breaks. Do not write the conclusion until the analysis is finished, and write out the full analysis before answering.'

const CATALOG = [{
  id: MODEL, name: MODEL, availability: 'available', vision: false, reasoning: true,
  contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false,
}]

const adapter = new FreeModelAdapter({
  state: () => ({
    catalog: CATALOG,
    membership: { [ROUTE_MAIN]: [MODEL], [ROUTE_REGION]: [] },
    settings: { enabled: true, defaultMaxTokens: 32768 },
    attributionUserAgent: 'probe/1.0',
  }),
  recordUsage: record => console.log(`  record        : ok=${record.ok} input=${record.input} output=${record.output} reasoning=${record.reasoning} truncated=${record.truncated === true} noUsage=${record.noUsage === true}`),
  warn: message => console.log(`  warn          : ${message}`),
})

console.log(`model=${MODEL} effort=${EFFORT} runs=${RUNS}`)
let cut = 0
let clean = 0
let ceiling = 0
for (let run = 1; run <= RUNS; run += 1) {
  const started = Date.now()
  let reasoningChars = 0
  let textChars = 0
  let firstDeltaAt = 0
  let finish = null
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
  }
  const elapsed = Date.now() - started
  const kind = finish?.kind ?? 'none'
  const code = finish?.failure?.code ?? ''
  const verdict = kind === 'error' && code === 'TRANSPORT' ? 'CUT (reported as a retryable failure)'
    : kind === 'max-tokens' ? 'CEILING (output budget reached, not a cut)'
      : kind === 'stop' ? 'CLEAN (reached its finish token)' : `OTHER (${kind})`
  if (verdict.startsWith('CUT')) cut++
  else if (verdict.startsWith('CLEAN')) clean++
  else if (verdict.startsWith('CEILING')) ceiling++
  console.log(`  wall          : ${(elapsed / 1000).toFixed(1)}s  first delta +${firstDeltaAt === 0 ? '-' : ((firstDeltaAt - started) / 1000).toFixed(1)}s  last frame ${(lastFrameAt === started ? 0 : (lastFrameAt - started) / 1000).toFixed(1)}s`)
  console.log(`  output        : reasoning ${reasoningChars} chars, text ${textChars} chars`)
  console.log(`  finish        : ${JSON.stringify(finish)}`)
  console.log(`  verdict       : ${verdict}`)
}
console.log(`\nsummary: ${clean} clean, ${ceiling} at the output ceiling, ${cut} cut-and-reported` )
console.log('note: 0 cut-and-reported does not falsify the fix — the gateway cut these unpredictably for the reporter, and `npm test` (truncation suite) proves the detection against a stream that really closes without a terminal frame.')
