/**
 * Proves the two upstream stream pathologies behind the reported "endless,
 * slow turns" cannot reach the harness as executable nonsense.
 *
 * Measured live against the gateway (2026-09-25): when the output ceiling cuts
 * a tool call's arguments mid-JSON, the gateway still reports finish
 * `tool_calls`, so trusting the token hands the harness an unexecutable call —
 * the tool errors, the model retries into the same ceiling, and the turn
 * loops. The adapter must read the arguments, not the token. The same lane
 * also occasionally answers a normal stop with zero blocks, which the kernel
 * contract requires adapters to classify as EMPTY_RESPONSE so it can retry.
 *
 * Run: node scripts/truncation-test.mjs
 */

import http from 'node:http'

/** Scripted SSE bodies, one per request, in order. */
const SCRIPT = []
let served = 0

const server = http.createServer((req, res) => {
  const body = SCRIPT[Math.min(served, SCRIPT.length - 1)]
  served++
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
// Set before the adapter module reads it: UPSTREAM_BASE is captured at import time.
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } = await import('../src/adapter.js')
const { finishReason } = await import('../src/stream.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const CATALOG = [
  {
    id: 'test-model-free', name: 'Test Model', availability: 'available',
    vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192,
  },
  // The other two wires are chosen by model id (`src/upstream.js`), and a
  // stream-closed check has to be proven on each of them separately.
  {
    id: 'muse-spark-1.3-contributor-free', name: 'Test Responses', availability: 'available',
    vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192,
  },
  {
    id: 'union-alpha', name: 'Test Messages', availability: 'available',
    vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192,
  },
]
const STATE = () => ({
  catalog: CATALOG,
  membership: { [ROUTE_MAIN]: CATALOG.map(entry => entry.id), [ROUTE_REGION]: [] },
  // 原始断流分类独立于续写策略，续写路径由 recovery-test 覆盖。
  settings: { enabled: true, defaultMaxTokens: 4096, streamRecovery: false },
  attributionUserAgent: 'test/1.0',
})

/** Drive the real adapter against one scripted SSE body; collect every chunk. */
async function drive(sse, model = 'test-model-free') {
  SCRIPT.push(sse)
  const records = []
  const adapter = new FreeModelAdapter({
    state: STATE,
    recordUsage: record => records.push(record),
    warn: () => {},
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)
  return { chunks, records }
}

const frame = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`
const toolFrame = (name, args, id) => frame({ tool_calls: [{ index: 0, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), ...(args ? { arguments: args } : {}) } }] })
const finishFrame = token => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: token }] })}\n\n`

// 1. The gateway misreport: arguments cut mid-string, finish still "tool_calls".
{
  const { chunks, records } = await drive(
    toolFrame('write_file', '{"path": "/tmp/x", "content": "# 截断') + finishFrame('tool_calls') + 'data: [DONE]\n\n')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('truncated tool arguments downgrade to max-tokens', finish?.reason, { kind: 'max-tokens' })
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  check('the truncated call is still streamed for the assembler to prune', blockEnd?.block?.arguments, '{"path": "/tmp/x", "content": "# 截断')
  check('a truncated turn still counts as a spent call', records.map(record => record.ok), [true])
}

// 2. A healthy tool call keeps its tool-calls finish.
{
  const { chunks } = await drive(
    toolFrame('read', '{"path": "/tmp/notes.txt"}', 'call_abc123') + finishFrame('tool_calls') + 'data: [DONE]\n\n')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  check('valid arguments keep the tool-calls finish', finish?.reason, { kind: 'tool-calls' })
  check('a provider id survives to the block-end', blockEnd?.block?.id, 'call_abc123')
}

// 3. A provider that streams arguments without an id still yields a usable one.
{
  const { chunks } = await drive(
    toolFrame('read', undefined, undefined) + toolFrame(undefined, '{"path": "/tmp/a"}', undefined) + finishFrame('tool_calls') + 'data: [DONE]\n\n')
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  check('a missing provider id is minted', typeof blockEnd?.block?.id === 'string' && blockEnd.block.id.length > 4, true)
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  check('the minted id flows in the deltas too', delta?.id, blockEnd?.block?.id)
}

// 4. Empty arguments are "{}", not a broken call.
{
  const { chunks } = await drive(
    toolFrame('bash', undefined, 'call_x') + finishFrame('tool_calls') + 'data: [DONE]\n\n')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('empty arguments stay a tool-calls finish', finish?.reason, { kind: 'tool-calls' })
}

// 5. A zero-block stop is EMPTY_RESPONSE, the kernel's retryable code.
{
  const { chunks, records } = await drive(frame({ role: 'assistant' }) + finishFrame('stop') + 'data: [DONE]\n\n')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  const failure = finish?.reason?.failure
  check('an empty stop is classified as EMPTY_RESPONSE', finish?.reason?.kind === 'error' && failure?.code, 'EMPTY_RESPONSE')
  check('the empty failure survives the durable log round trip',
    JSON.stringify(failure) != null && JSON.parse(JSON.stringify(failure ?? {})).code, 'EMPTY_RESPONSE')
  check('an empty stop counts as a failed call', records.map(record => record.ok), [false])
}

// 6. Reasoning-only output is not empty — the user saw something.
{
  const { chunks } = await drive(frame({ reasoning: '思考中。' }) + finishFrame('stop') + 'data: [DONE]\n\n')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('reasoning-only keeps a stop finish', finish?.reason, { kind: 'stop' })
}

// 7. The mapping table itself, so the tokens stay pinned.
check('finish tokens map through', ['tool_calls', 'length', 'stop'].map(finishReason), [{ kind: 'tool-calls' }, { kind: 'max-tokens' }, { kind: 'stop' }])

// ─── issue #10: the stream the gateway closed early ───────────────────────────
// Measured live (`scripts/probes/stream-terminal-frames.mjs`): a complete answer
// on this lane always ends with a finish_reason frame, then a usage frame, then
// `data: [DONE]`. A stream that reaches none of them was not finished by the
// model. Reporting that as `stop` — what `finishReason(undefined)` falls through
// to — is how a five-minute thinking round ended silently, marked completed, and
// logged 0/0 tokens.

// 8. A cut stream on the Chat wire is a failure, not a completed turn — and only
// the cut that delivered nothing is worth sending again. Measured in a real `dsh`
// web session (2026-09-27): while the code was retryable the harness re-sent the
// same five-minute turn twice over (`llm/retry` at 304 s and 608 s, `turn/end` at
// 912 s) — three identical failures, fifteen minutes, one unanswered turn.
const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
{
  const { chunks, records } = await drive(frame({ reasoning: 'thinking' }) + frame({ reasoning: ' still thinking' }))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('a stream with no terminal frame is an error, not a stop', finish?.reason?.kind, 'error')
  check('…and is counted as a failed call', records.map(record => record.ok), [false])
  check('…and is marked in the audit row', records.map(record => record.truncated), [true])
  check('the reasoning that did arrive is still handed over', chunks.some(chunk => chunk.type === 'reasoning-delta'), true)
  check('a cut that had already streamed content is not re-sent', RETRYABLE.includes(finish?.reason?.failure?.code), false)
  check('…and says how long it ran before dying', /after \d+s/.test(finish?.reason?.failure?.message ?? ''), true)

  // A role-only frame is not a delta: nothing of the answer arrived, so repeating
  // the turn costs what a blip costs, and the cap that bites the five-minute
  // thinking round cannot bite this one.
  const silent = await drive(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`)
  const silentFinish = silent.chunks.find(chunk => chunk.type === 'finish')
  check('a cut that delivered no token at all stays retryable',
    [silentFinish?.reason?.failure?.code, RETRYABLE.includes(silentFinish?.reason?.failure?.code)], ['TRANSPORT', true])
  check('…and is still a failed, truncated row', silent.records.map(record => [record.ok, record.truncated]), [[false, true]])
}

// 9. A finish token with no usage frame stays a success, but says so.
{
  const { records } = await drive(frame({ content: 'done' }) + finishFrame('stop') + 'data: [DONE]\n\n')
  check('a complete turn without a usage frame is not called truncated', records.map(record => record.truncated ?? false), [false])
  check('…but the missing usage is recorded', records.map(record => record.noUsage), [true])
  const withUsage = await drive(frame({ content: 'done' }) + finishFrame('stop') + 'data: [DONE]\n\n')
  check('a plain stop keeps its finish reason', withUsage.chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })
}

// 10. The same test on the Responses wire, which ends on its own terminal event.
{
  const cut = `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' })}\n\n`
  const cutOut = await drive(cut, 'muse-spark-1.3-contributor-free')
  check('a Responses stream with no response.completed is an error', cutOut.chunks.find(chunk => chunk.type === 'finish')?.reason?.failure?.code, 'STREAM_CUT')
  const done = await drive(
    cut + `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } })}\n\n`,
    'muse-spark-1.3-contributor-free')
  check('a Responses stream that did complete stays a stop', done.chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })
  check('…and is not flagged', done.records.map(record => record.truncated ?? false), [false])
}

// 11. And on the Messages wire, whose own end frame is `message_stop`.
{
  const cutClaude = `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`
  const cutOut = await drive(cutClaude, 'union-alpha')
  check('a Messages stream closed mid-turn is an error', cutOut.chunks.find(chunk => chunk.type === 'finish')?.reason?.failure?.code, 'STREAM_CUT')
  const stopped = await drive(cutClaude + `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`, 'union-alpha')
  check('message_stop counts as a real end even without a stop_reason', stopped.chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })
  check('…and the call is a success', stopped.records.map(record => record.ok), [true])
}

// 12. The other endings on these two wires are deliberate too. Reading only
// `response.completed` as terminal turned a turn that hit its output ceiling into
// a transport fault, and issue #10's own check then retried it twice — the retry
// the fix exists to enable, spent on a stream that had already finished.
{
  const sse = type => `data: ${JSON.stringify({ type })}\n\n`
  const partial = `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' })}\n\n`
  const incomplete = await drive(partial + `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 4096 } } })}\n\n`, 'muse-spark-1.3-contributor-free')
  check('a Responses turn cut by its ceiling is max-tokens, not a cut stream', incomplete.chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'max-tokens' })
  check('…and is recorded as a call that answered', incomplete.records.map(record => record.ok), [true])
  check('…and not flagged truncated', incomplete.records.map(record => record.truncated ?? false), [false])
  const doneOnly = await drive(partial + sse('response.done'), 'muse-spark-1.3-contributor-free')
  check('a bare response.done is an end, not a truncation', [doneOnly.chunks.find(chunk => chunk.type === 'finish')?.reason, doneOnly.records.map(r => r.truncated ?? false)], [{ kind: 'stop' }, [false]])

  // A terminal frame that names no reason marks the end; it must not erase the
  // finish token the status-carrying frame already gave.
  const ceilingClaude = await drive(
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`
      + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } })}\n\n`
      + sse('message_stop'), 'union-alpha')
  check('message_stop does not overwrite the stop_reason it followed', ceilingClaude.chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'max-tokens' })
}

// The listener is unref'd at creation; the exit below must not race a close()
// on Windows (libuv asserts on handles mid-close), so just let the process end.
console.log(failures === 0 ? '\nall truncation checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
