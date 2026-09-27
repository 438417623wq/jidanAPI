/**
 * The message vocabulary: does a tool result reach the upstream model?
 *
 * Issue #9 is that dsh has shipped two shapes for a tool answer, and this
 * projector only ever read one of them. A pre-V4 kernel answers a tool call with
 * a `user` message whose content holds a `tool-result` wrapper block; V4 made it
 * a first-class `tool` message whose content *is* the result. Reading only the
 * second meant every free-lane agent turn went upstream with its results
 * removed, so the model re-issued the same call forever — and the existing
 * selftest could not catch it because it built its fixture out of the shape the
 * plugin already understood.
 *
 * So every case here is driven from the recorded bytes of real durable sessions
 * (`~/.dsh/sessions` under `session.vN.jsonl.zstd`), not from an imagined one:
 *
 *   V1/V3 `tool/result` → {role:'user',   source:{kind:'tool',callId},
 *                          content:[{type:'tool-result',toolCallId,content:[…],isError}]}
 *   V4    `tool/result` → {role:'tool',   toolCallId, isError, content:[…]}
 *
 * Run: node scripts/projection-test.mjs
 */

import { repairToolPairing, toChatMessages, toClaudeMessages, toResponseInput } from '../src/messages.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const IMAGE = { type: 'image', attachment: { attachmentId: 'att_1', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' } }
const resolveImage = () => 'data:image/png;base64,AAAA'

/** The V1/V3 shape, verbatim from the durable logs. */
const v3Result = (callId, text) => ({
  role: 'user',
  source: { kind: 'tool', callId },
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
  id: `msg-${callId}`,
})

/** The V4 shape, verbatim from the durable logs. */
const v4Result = (callId, text, extra = {}) => ({
  role: 'tool',
  source: { kind: 'tool', callId },
  toolCallId: callId,
  isError: false,
  content: [{ type: 'text', text }],
  id: `msg-${callId}`,
  ...extra,
})

const callBlock = (id, name = 'glob', args = '{"pattern":"**/*.jpg"}') => ({ type: 'tool-call', id, name, arguments: args })

/** One answered call, answered either way. */
const history = shape => [
  { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
  { role: 'user', content: [{ type: 'text', text: 'find the jpg' }] },
  { role: 'assistant', content: [callBlock('call_1')] },
  shape === 'v3' ? v3Result('call_1', 'IMG_20260926_060423.jpg') : v4Result('call_1', 'IMG_20260926_060423.jpg'),
  { role: 'user', content: [{ type: 'text', text: '继续' }] },
]

/** What actually crossed the wire, counted the way the issue counted it. */
function tally(chat) {
  return {
    calls: chat.filter(m => m.role === 'assistant' && m.tool_calls?.length > 0).length,
    results: chat.filter(m => m.role === 'tool').length,
  }
}

console.log('=== 1. the call and its result both reach the model, in either vocabulary ===')
for (const shape of ['v3', 'v4']) {
  const repaired = repairToolPairing(history(shape))
  check(`${shape}: the answered tool-call survives the pairing repair`, tally(toChatMessages(repaired, resolveImage, [])), { calls: 1, results: 1 })
  const chat = toChatMessages(repaired, resolveImage, [])
  check(`${shape}: the result text is the model-visible answer`, chat.find(m => m.role === 'tool')?.content, 'IMG_20260926_060423.jpg')
  check(`${shape}: the result is keyed to the call it answers`, chat.find(m => m.role === 'tool')?.tool_call_id, 'call_1')
  const claude = toClaudeMessages(repaired, resolveImage, [])
  check(`${shape}: Messages wire carries a tool_result block`, claude.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result').map(b => b.tool_use_id), ['call_1'])
  const responses = toResponseInput(repaired, resolveImage, [])
  check(`${shape}: Responses wire carries the function_call + its output`, [
    responses.filter(i => i.type === 'function_call').length, responses.filter(i => i.type === 'function_call_output').length,
  ], [1, 1])
}

console.log('\n=== 2. the repair still removes what has no answer ===')
{
  const orphanAnswer = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    // A call that was interrupted before its answer landed.
    { role: 'assistant', content: [callBlock('call_gone')] },
    { role: 'user', content: [{ type: 'text', text: 'next question' }] },
  ]
  check('an unanswered call is dropped (no 400 for the whole session)', toChatMessages(repairToolPairing(orphanAnswer), resolveImage, []).map(m => m.role), ['user', 'user'])

  const answerWithoutCall = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    v3Result('call_never_made', 'x'),
  ]
  check('a result with no call before it is dropped', toChatMessages(repairToolPairing(answerWithoutCall), resolveImage, []).map(m => m.role), ['user'])
  check('…in the V4 shape too', toChatMessages(repairToolPairing([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, v4Result('call_never_made', 'x')]), resolveImage, []).map(m => m.role), ['user'])

  const toolNoId = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'tool', content: [{ type: 'text', text: 'x' }] }]
  check('a tool answer with no call id cannot reach the wire', toChatMessages(repairToolPairing(toolNoId), resolveImage, []).map(m => m.role), ['user'])
}

console.log('\n=== 3. parallel calls: every result survives, in order, keyed correctly ===')
{
  const parallel = [
    { role: 'user', content: [{ type: 'text', text: 'three files' }] },
    { role: 'assistant', content: [callBlock('a', 'read'), callBlock('b', 'read'), callBlock('c', 'read')] },
    v3Result('a', 'one'), v3Result('b', 'two'), v3Result('c', 'three'),
  ]
  const chat = toChatMessages(repairToolPairing(parallel), resolveImage, [])
  check('chat keeps all three answers', chat.filter(m => m.role === 'tool').map(m => `${m.tool_call_id}=${m.content}`), ['a=one', 'b=two', 'c=three'])
  const claude = toClaudeMessages(repairToolPairing(parallel), resolveImage, [])
  check('claude merges them into one user turn (results first)', claude.messages.map(m => `${m.role}:${m.content.map(b => b.type).join(',')}`), ['user:text', 'assistant:tool_use,tool_use,tool_use', 'user:tool_result,tool_result,tool_result'])
  // One call answered, two interrupted: the unanswered ones must not 400 the turn.
  const partial = [
    { role: 'user', content: [{ type: 'text', text: 'three files' }] },
    { role: 'assistant', content: [callBlock('a', 'read'), callBlock('b', 'read')] },
    v3Result('a', 'one'),
  ]
  const repairedPartial = toChatMessages(repairToolPairing(partial), resolveImage, [])
  check('a half-answered parallel turn keeps the answered call only', repairedPartial.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls?.map(c => c.id) ?? []), ['a'])
  check('…and its result is still emitted', repairedPartial.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a'])
}

console.log('\n=== 4. a tool that returned an image ===')
{
  const imageResultV3 = [{ role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', content: [callBlock('im', 'read_image', '{"path":"a.png"}')] },
    { role: 'user', source: { kind: 'tool', callId: 'im' }, content: [{ type: 'tool-result', toolCallId: 'im', content: [IMAGE], isError: false }] },
  ]
  const imageResultV4 = [{ role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', content: [callBlock('im', 'read_image', '{"path":"a.png"}')] },
    v4Result('im', '', { content: [IMAGE] }),
  ]
  for (const [label, src] of [['V3 wrapper', imageResultV3], ['V4 tool role', imageResultV4]]) {
    const warnings = []
    const chat = toChatMessages(repairToolPairing(src), resolveImage, warnings)
    check(`${label}: chat says the image is attached instead of nothing`, chat.find(m => m.role === 'tool')?.content, '(see attached image)')
    check(`${label}: chat follows with the image itself`, chat.filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').map(() => 'img') : []), ['img'])
    check(`${label}: nothing was silently dropped`, warnings, [])
    const claudeBlocks = toClaudeMessages(repairToolPairing(src), resolveImage, []).messages.flatMap(m => m.content)
    check(`${label}: Messages wire nests the image inside tool_result`, claudeBlocks.filter(b => b.type === 'tool_result').map(b => b.content.map(x => x.type).join(',')), ['image'])
  }
  const offloaded = [{ role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', content: [callBlock('im', 'read_image', '{}')] },
    v3Result('im', ''), { ...v3Result('im', ''), content: [{ type: 'tool-result', toolCallId: 'im', content: [{ ...IMAGE, offloaded: true }], isError: false }] },
  ]
  const warnings = []
  toChatMessages(repairToolPairing(offloaded), resolveImage, warnings)
  check('an offloaded image is reported, not passed as a dead reference', warnings.includes('image-dropped'), true)
}

console.log('\n=== 5. error results and empty results ===')
{
  const errV3 = [{ role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [callBlock('e', 'bash', '{"command":"ls"}')] },
    { role: 'user', source: { kind: 'tool', callId: 'e' }, content: [{ type: 'tool-result', toolCallId: 'e', content: [{ type: 'text', text: 'Error: not found' }], isError: true }] },
  ]
  const claudeErr = toClaudeMessages(repairToolPairing(errV3), resolveImage, []).messages.flatMap(m => m.content).find(b => b.type === 'tool_result')
  check('a V3 error result keeps is_error', claudeErr?.is_error, true)
  const claudeV4Err = toClaudeMessages(repairToolPairing([{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [callBlock('e')] }, v4Result('e', 'Error: not found', { isError: true })]), resolveImage, []).messages.flatMap(m => m.content).find(b => b.type === 'tool_result')
  check('…and so does a V4 one', claudeV4Err?.is_error, true)

  const empty = [{ role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [callBlock('z')] },
    { role: 'user', source: { kind: 'tool', callId: 'z' }, content: [{ type: 'tool-result', toolCallId: 'z', content: [], isError: false }] },
  ]
  check('a result with no content at all still answers the call', toChatMessages(repairToolPairing(empty), resolveImage, []).find(m => m.role === 'tool')?.content, '(no output)')
}

console.log('\n=== 6. the repair must stay inert on history that is already sound ===')
{
  // `scripts/probes/pairing-repair.mjs` proves the same against the live gateway,
  // but only for the shape it builds by hand; this pins it for both vocabularies
  // so a future edit cannot start rewriting turns that needed nothing.
  for (const shape of ['v3', 'v4']) {
    const input = history(shape)
    check(`${shape}: a well-formed turn is returned byte-for-byte unchanged`, JSON.stringify(repairToolPairing(input)) === JSON.stringify(input), true)
  }
  const textOnly = [{ role: 'assistant', content: [{ type: 'text', text: 'no tools here' }], source: { kind: 'model' } }]
  check('a plain assistant answer is untouched', JSON.stringify(repairToolPairing(textOnly)) === JSON.stringify(textOnly), true)
}

console.log('\n=== 7. one answer goes out, not two, on every wire ===')
{
  // The Messages wire merges a result into the user turn it builds, so a message
  // that emits its `tool_result` and then falls through to the generic block loop
  // sends the same content a second time — the text twice, and a returned image's
  // whole base64 payload twice. Asserting the block *types* (section 1) cannot see
  // that; counting the answer in the bytes that go out can.
  for (const shape of ['v3', 'v4']) {
    const sent = answer => JSON.stringify(answer).split('IMG_20260926_060423.jpg').length - 1
    const repaired = repairToolPairing(history(shape))
    check(`${shape}: Chat carries the answer once`, sent(toChatMessages(repaired, resolveImage, [])), 1)
    check(`${shape}: Messages carries the answer once`, sent(toClaudeMessages(repaired, resolveImage, [])), 1)
    check(`${shape}: Responses carries the answer once`, sent(toResponseInput(repaired, resolveImage, [])), 1)
  }
  const imageAnswer = {
    role: 'user', source: { kind: 'tool', callId: 'im' },
    content: [{ type: 'tool-result', toolCallId: 'im', content: [IMAGE], isError: false }],
  }
  const turn = [{ role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [callBlock('im', 'read_image', '{}')] }, imageAnswer]
  check('a result image is base64-encoded once on the Messages wire',
    JSON.stringify(toClaudeMessages(repairToolPairing(turn), resolveImage, [])).split('AAAA').length - 1, 1)
}

console.log(failures === 0 ? '\nall projection checks passed' : `\n${failures} projection check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
