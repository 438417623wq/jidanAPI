/** Exercise the signing boundary with disposable Git repositories and keys. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareRelease } from './prepare-release.mjs'
import { parseManifest, verifyManifestSignature } from '../src/updater.js'
import { publishedBytes } from './lib/published-bytes.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-preparation-test-'))
const repo = path.join(scratch, 'candidate')
fs.mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const write = (rel, data) => {
  const file = path.join(repo, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'object' && !Buffer.isBuffer(data) ? `${JSON.stringify(data, null, 2)}\n` : data)
}
const commit = label => { git('add', '.'); git('commit', '-qm', label); return git('rev-parse', 'HEAD') }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const verificationKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const prepare = (base, candidate, name, extra = {}) => prepareRelease({
  repo, base, candidate, signingKey: privateKey, verificationKey,
  output: path.join(scratch, name), ...extra,
})
let checks = 0
const check = (name, fn) => { fn(); checks += 1; console.log(`ok   ${name}`) }

try {
  git('init', '-q', '--initial-branch=main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'release fixture')
  git('config', 'core.autocrlf', 'false')
  const pkg = { name: 'fixture', version: '1.4.4', files: ['index.js', 'README.md', 'src'] }
  write('package.json', pkg)
  write('index.js', 'export const version = 1\n')
  write('README.md', 'fixture\r\n')
  write('src/nested/module.js', 'export const value = 1\r\n')
  write('src/blob.bin', Buffer.from([0, 13, 10, 4]))
  write('feed/manifest.json', { version: pkg.version, notes: 'reviewed notes', files: [] })
  write('catalog/integrity.json', { version: pkg.version, algorithm: 'sha256', files: [] })
  write('catalog/dsh-plugin.json', { version: pkg.version, source: { revision: '0'.repeat(40) } })
  write('catalog/provenance.json', { subject: { version: pkg.version, sourceRevision: '0'.repeat(40) } })
  const base = commit('base')
  const sentinel = path.join(scratch, 'candidate-code-executed')
  const malicious = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw new Error('candidate ran')\n`
  write('src/updater.js', malicious)
  write('scripts/build-manifest.mjs', malicious)
  write('scripts/prepare-release.mjs', malicious)
  write('index.js', 'export const version = 2\n')
  const content = commit('reviewed code')
  write('docs/note.md', 'non-published documentation\n')
  const candidate = commit('documentation')
  const receipt = prepare(base, candidate, 'prepared')
  const patch = fs.readFileSync(path.join(scratch, 'prepared/release.patch'))
  check('candidate code and its replacement signing scripts never execute', () => assert.equal(fs.existsSync(sentinel), false))
  check('receipt binds the base, exact candidate, last content commit and patch bytes', () => {
    assert.equal(receipt.base, base)
    assert.equal(receipt.candidate, candidate)
    assert.equal(receipt.contentRevision, content)
    assert.equal(receipt.patchSha256, crypto.createHash('sha256').update(patch).digest('hex'))
  })
  check('preparation does not change the candidate checkout or commit', () => {
    assert.equal(git('status', '--porcelain'), '')
    assert.equal(git('rev-parse', 'HEAD'), candidate)
  })
  const patchFile = path.join(scratch, 'prepared/release.patch')
  git('apply', '--check', patchFile)
  git('apply', patchFile)
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'feed/manifest.json')))
  check('the actual updater verifier accepts the prepared signature', () =>
    assert.equal(verifyManifestSignature(parseManifest(manifest), verificationKey), true))
  check('all nested files and binary/LF byte digests describe the candidate', () => {
    assert.equal(manifest.files.length, 6)
    for (const row of manifest.files) {
      const bytes = publishedBytes(fs.readFileSync(path.join(repo, row.path)))
      assert.equal(row.size, bytes.length)
      assert.equal(row.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    }
    assert.equal(manifest.files.find(row => row.path === 'src/blob.bin').size, 4)
    assert.equal(manifest.files.find(row => row.path === 'README.md').size, 8)
  })
  check('both catalog revisions name the content commit after a metadata-only commit', () => {
    commit('signature and catalog')
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'catalog/dsh-plugin.json'))).source.revision, content)
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'catalog/provenance.json'))).subject.sourceRevision, content)
    assert.equal(git('log', '-1', '--format=%H', '--', 'package.json', ...pkg.files), content)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, 'catalog/integrity.json'))).files, manifest.files)
  })
  const metadata = git('rev-parse', 'HEAD')
  check('a normal PR merge preserves the catalog content revision', () => {
    git('branch', 'signed-candidate', metadata)
    git('switch', '-q', '-c', 'integration', base)
    git('merge', '--no-ff', '-qm', 'prospective PR merge', 'signed-candidate')
    assert.equal(git('log', '-1', '--format=%H', '--', 'package.json', ...pkg.files), content)
    git('switch', '-q', 'main')
  })
  check('patch contains only the four release records, without keys', () => {
    const paths = patch.toString().split('\n').filter(line => line.startsWith('diff --git ')).map(line => line.split(' ')[3].slice(2)).sort()
    assert.deepEqual(paths, ['catalog/dsh-plugin.json', 'catalog/integrity.json', 'catalog/provenance.json', 'feed/manifest.json'])
    assert.equal(patch.toString().includes('PRIVATE KEY'), false)
  })
  check('tampering with a signed digest is rejected by the updater', () => {
    const bad = structuredClone(manifest)
    bad.files[0].sha256 = '0'.repeat(64)
    assert.equal(verifyManifestSignature(parseManifest(bad), verificationKey), false)
  })
  check('a wrong release key fails before writing output', () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey
    assert.throws(() => prepare(base, metadata, 'wrong-key', { signingKey: other }), /pinned release key/)
    assert.equal(fs.existsSync(path.join(scratch, 'wrong-key')), false)
  })
  check('an invalid SHA or non-ancestor base cannot be signed', () => {
    assert.throws(() => prepare(base, '--help', 'bad-sha'), /full lowercase commit SHAs/)
    assert.throws(() => prepare(metadata, base, 'bad-base'))
  })
  write('package.json', { ...pkg, version: '1.0.0' })
  const downgrade = commit('downgrade')
  check('release version downgrade is rejected', () =>
    assert.throws(() => prepare(base, downgrade, 'downgrade'), /version downgrade/))
  write('package.json', { ...pkg, files: ['../outside'] })
  const outside = commit('unsafe path')
  check('package paths cannot escape the candidate or become pathspec options', () =>
    assert.throws(() => prepare(base, outside, 'outside'), /unsafe package files entry/))
  write('package.json', pkg)
  // Creating a symlink takes privilege on Windows; where the OS refuses, say so
  // and move on — the rejection path stays covered by CI (ubuntu).
  let linked = null
  try {
    fs.symlinkSync(sentinel, path.join(repo, 'src/link.js'))
    linked = commit('linked file')
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    console.log('skip  symlink rejection (this environment cannot create symlinks)')
  }
  if (linked !== null) {
    check('symlinks are rejected instead of dereferenced', () => {
      assert.throws(() => prepare(base, linked, 'linked'), /tracked regular file/)
      assert.equal(fs.existsSync(sentinel), false)
    })
    fs.unlinkSync(path.join(repo, 'src/link.js'))
  }
  write('src/large.js', Buffer.alloc(4 * 1024 * 1024 + 1, 65))
  const large = commit('oversized file')
  check('oversized files fail before publishing an artifact', () =>
    assert.throws(() => prepare(base, large, 'large'), /size limit/))

  const scripts = fileURLToPath(new URL('.', import.meta.url))
  for (const args of [['--mode', 'invalid'], ['--mode'], ['--only'], ['--mode', 'contributor', '--only', 'manifest'], ['--mode', 'release', '--only', 'forward']]) {
    check(`test selection fails closed: ${args.join(' ')}`, () => {
      const run = spawnSync(process.execPath, [path.join(scripts, 'test-all.mjs'), ...args], { encoding: 'utf8' })
      assert.equal(run.status, 1)
    })
  }
  console.log(`\nrelease-preparation: ${checks} checks passed; disposable keys only`)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
