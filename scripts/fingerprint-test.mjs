/**
 * The free tier's tool fingerprint: four names must be declared, and every one of
 * them must be something the caller can actually execute.
 *
 * The gateway refuses a request that does not declare `bash`, `glob`, `grep` and
 * `read` in `body.tools` (403 FreeTierError), so the plugin fills any gap. Filling
 * it with a decoy is what issue #9's second half is about: dsh names its shell
 * tool `pwsh` on Windows, so `bash` was declared as a tool whose own description
 * said "must not be used" — and models called it anyway, 24 times in one recorded
 * session, every call returning unknown tool. Promoting the real shell into the
 * slot satisfies the same gate and answers the call with a tool that exists.
 *
 * Run: node scripts/fingerprint-test.mjs
 */

import { applyFingerprint, FINGERPRINT_TOOLS, restoreToolName } from '../src/upstream.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const chatTool = name => ({ type: 'function', function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } } })
const flatTool = name => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } })
const declared = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)

console.log('=== 1. the Windows session: pwsh stands in for the bash slot ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('read'), chatTool('glob'), chatTool('grep')] }
  const map = applyFingerprint(body, false)
  check('all four quartet names are declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('no decoy was needed', body.tools.filter(tool => tool.function?.description?.includes('must not be used')).map(tool => tool.function.name), [])
  check('the slot carries the real tool description', body.tools.find(tool => tool.function?.name === 'bash')?.function?.description, 'the pwsh tool')
  check('the rename map sends bash back to pwsh', map.get('bash'), 'pwsh')
  check('a model call for bash is executable downstream', restoreToolName('bash', map), 'pwsh')
  check('unrelated names pass through the map untouched', restoreToolName('write', map), 'write')
}

console.log('\n=== 2. the same holds on the flat Responses shape ===')
{
  const body = { tools: [flatTool('pwsh'), flatTool('read'), flatTool('glob'), flatTool('grep')] }
  const map = applyFingerprint(body, true)
  check('quartet declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('pwsh promoted, not duplicated', declared(body).filter(name => name === 'pwsh' || name === 'bash'), ['bash'])
  check('map restored', restoreToolName('bash', map), 'pwsh')
}

console.log('\n=== 3. a real bash wins over the donor, and nothing is duplicated ===')
{
  const body = { tools: [chatTool('bash'), chatTool('pwsh')] }
  const map = applyFingerprint(body, false)
  check('bash stays bash', declared(body).filter(n => n === 'bash' || n === 'pwsh'), ['bash', 'pwsh'])
  check('bash is not remapped to pwsh', map.has('bash'), false)
  const cased = { tools: [chatTool('Bash'), chatTool('Grep'), chatTool('Glob'), chatTool('Read')] }
  const casedMap = applyFingerprint(cased, false)
  check('case variants are canonicalised once, not duplicated', declared(cased), ['bash', 'grep', 'glob', 'read'])
  check('…and each is restored to the caller spelling', ['bash', 'grep', 'glob', 'read'].map(name => restoreToolName(name, casedMap)), ['Bash', 'Grep', 'Glob', 'Read'])
}

console.log('\n=== 4. with nothing to promote, the decoy still clears the gate ===')
{
  const body = { tools: [chatTool('browser_navigate')] }
  const map = applyFingerprint(body, false)
  check('every quartet name is still declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('the four decoys say what they are', body.tools.filter(tool => tool.function?.description?.includes('must not be used')).map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  check('a decoy is not in the rename map, so it is never called a real tool', map.has('bash'), false)
}

console.log('\n=== 5. a caller with no tools at all ===')
{
  const body = {}
  applyFingerprint(body, false)
  check('the gate is still satisfied', FINGERPRINT_TOOLS.every(name => declared(body).includes(name)), true)
  check('and no tool_choice is claimed', body.tool_choice, 'none')
  const withTools = { tools: [chatTool('write')] }
  applyFingerprint(withTools, false)
  check('a caller that brought tools keeps tool_choice unset so the model decides', withTools.tool_choice, undefined)
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
