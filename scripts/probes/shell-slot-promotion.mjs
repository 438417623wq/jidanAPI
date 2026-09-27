/**
 * Does the free-tier fingerprint gate accept a promoted shell tool, and does the
 * call come back executable?
 *
 * Issue #9's second half: the gate wants `bash` declared. On Windows dsh mounts
 * `pwsh` instead (`packages/shell/tool-pwsh`), so the plugin used to append a
 * decoy named `bash` whose own description said "must not be used" — and models
 * called it anyway (24 unknown-tool results in one reported session). The fix
 * promotes the real shell tool into the slot and renames the answer back.
 *
 * Two things can only be settled against the live gateway, which is what this
 * probe is for:
 *   1. the gate accepts `bash` carrying another tool's schema (no 403 FreeTierError);
 *   2. the tool call that comes back is named `pwsh`, i.e. the kernel can run it.
 *
 * Run: node scripts/probes/shell-slot-promotion.mjs [model]
 */

import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../../src/adapter.js'
import { applyFingerprint } from '../../src/upstream.js'

const MODEL = process.argv[2] ?? 'space-bunny-free'
const SHELL_TOOLS = [{
  name: 'pwsh',
  description: 'Run a PowerShell command on Windows and return its stdout.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}]

// What goes on the wire, asserted before a request is even made.
const preview = { tools: [{ type: 'function', function: { ...SHELL_TOOLS[0] } }] }
const previewMap = applyFingerprint(preview, false)
console.log('declared names  :', preview.tools.map(tool => tool.function.name).join(', '))
console.log('rename map      :', [...previewMap].map(([sent, original]) => `${sent}->${original}`).join(', ') || '(none)')
console.log('decoys present  :', preview.tools.filter(tool => tool.function.description?.includes('must not be used')).map(tool => tool.function.name).join(', ') || 'none')

const CATALOG = [{
  id: MODEL, name: MODEL, availability: 'available', vision: false, reasoning: false,
  contextWindow: 128000, maxOutput: 8192,
}]
const adapter = new FreeModelAdapter({
  state: () => ({
    catalog: CATALOG,
    membership: { [ROUTE_MAIN]: [MODEL], [ROUTE_REGION]: [] },
    settings: { enabled: true, defaultMaxTokens: 1024 },
    attributionUserAgent: 'probe/1.0',
  }),
  recordUsage: () => {},
  warn: message => console.log('  warn:', message),
})

const calls = []
let finish = null
let text = ''
for await (const chunk of adapter.stream({
  provider: ROUTE_MAIN,
  model: MODEL,
  sessionId: 'probe:shell-slot-promotion',
  maxTokens: 512,
  tools: SHELL_TOOLS,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the shell tool once to print the current date. Do not answer in prose.' }] }],
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls.push(chunk.block)
  if (chunk.type === 'finish') finish = chunk.reason
}

console.log('\nfinish          :', JSON.stringify(finish))
console.log('text            :', JSON.stringify(text.slice(0, 120)))
console.log('tool calls back :', JSON.stringify(calls.map(call => ({ name: call.name, id: call.id, arguments: call.arguments }))))

const named = calls.map(call => call.name)
const gateAccepted = finish?.failure?.code !== 'REGION_BLOCKED' && !/FreeTier|403/i.test(finish?.failure?.message ?? '')
const restoredToPwsh = named.length === 0 || named.every(name => name === 'pwsh')
const decoyNotCalled = !named.includes('bash')
console.log('\nverdict:')
console.log(`  gateway accepted the promoted declaration : ${gateAccepted ? 'yes' : `NO — ${JSON.stringify(finish)}`}`)
console.log(`  no call surfaced as the decoy name "bash" : ${decoyNotCalled ? 'yes' : 'NO — the model called bash and it was not restored'}`)
console.log(`  any call came back as pwsh (executable)   : ${restoredToPwsh ? (named.length > 0 ? 'yes' : 'n/a — model issued no call, rerun') : 'NO'}`)
process.exitCode = gateAccepted && decoyNotCalled && restoredToPwsh ? 0 : 1
