/**
 * What does a *complete* stream actually end with on this lane?
 *
 * Issue #10 is a claim about the tail of a stream: the gateway closed the body
 * without ever sending a finish token. Deciding that from the plugin's own
 * reader is impossible, because `readSse` drops `data: [DONE]` before the
 * parser sees it — so the reader cannot tell "the server said it was done" from
 * "the socket happened to close". This captures the bytes verbatim off `fetch`
 * and prints every frame's discriminator, in order, plus the close reason.
 *
 * Run: node scripts/probes/stream-terminal-frames.mjs [model]
 */

import { applyFingerprint, endpointFor, gatewayHeaders, mintRequestId, mintSessionId, wireFor, UPSTREAM_BASE } from '../../src/upstream.js'

const MODEL = process.argv[2] ?? 'space-bunny-free'
const wire = wireFor(MODEL)
const session = mintSessionId()

const prompt = 'Reply with exactly: FRAME-OK'
const body = wire === 'responses'
  ? { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: true, store: false, max_output_tokens: 64 }
  : wire === 'messages'
    ? { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], stream: true }
    : { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: prompt }], stream: true }
applyFingerprint(body, wire === 'flat' || wire === 'responses')

const headers = gatewayHeaders({ session, requestId: mintRequestId(), stream: true })
const started = Date.now()
const res = await fetch(`${UPSTREAM_BASE}${endpointFor(MODEL)}`, {
  method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
})
console.log(`model=${MODEL} wire=${wire} status=${res.status} content-type=${res.headers.get('content-type')}`)
if (!res.ok) { console.log((await res.text()).slice(0, 400)); process.exit(1) }

const decoder = new TextDecoder()
let buffer = ''
let index = 0
const kinds = []
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true })
  let nl = buffer.indexOf('\n')
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    nl = buffer.indexOf('\n')
    if (line === '') continue
    let tag = line
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') tag = 'data: [DONE]'
      else {
        let p
        try { p = JSON.parse(payload) } catch { p = null }
        if (p === null) tag = `data: <unparseable ${payload.slice(0, 40)}>`
        else {
          const fr = p.choices?.[0]?.finish_reason
          tag = `data: type=${p.type ?? '-'}${fr !== undefined ? ` finish_reason=${JSON.stringify(fr)}` : ''}${p.usage ? ' WITH-USAGE' : ''}${p.choices?.[0]?.delta?.content ? ' has-content' : ''}`
          kinds.push(tag)
        }
      }
      if (tag.startsWith('data: [DONE]')) kinds.push(tag)
    }
    console.log(`${String(index++).padStart(4)}  ${tag.slice(0, 120)}`)
    if (process.env.RAW === '1' && line.startsWith('data:')) console.log(`      raw: ${line.slice(5).trim().slice(0, 300)}`)
  }
}
buffer += decoder.decode()
if (buffer.trim() !== '') console.log(`${String(index).padStart(4)}  <tail> ${buffer.trim().slice(0, 120)}`)

console.log(`\nclose: body stream ended normally (no reader error) after ${Date.now() - started}ms, ${index} lines`)
const sawFinish = kinds.some(k => /finish_reason="(?!null)[^"]+"/.test(k))
const sawDone = kinds.includes('data: [DONE]')
console.log(`verdict: finish_token_present=${sawFinish}  DONE_sentinel_present=${sawDone}`)
console.log('  → a clean end on this wire therefore ' + (sawDone ? 'DOES include `data: [DONE]`' : 'does NOT include `data: [DONE]`')
  + ', and ' + (sawFinish ? 'always carries a finish_reason' : 'carries no finish_reason at all'))
