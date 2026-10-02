/**
 * Outbound wire for the co-paid lane.
 *
 * A deliberately plain OpenAI-compatible relay: `/chat/completions` over SSE
 * with one bearer credential, no session fingerprint headers, no per-model
 * endpoint split. The credential arrives per call from the sealed store
 * (`src/vault.js`) and lives only inside the call frame that builds the
 * headers; nothing here logs it, caches it, or names it in an error.
 *
 * Every failure is classified into the same harness-neutral codes the free
 * lane uses, with the endpoint and the credential absent from every message.
 *
 * @module src/eac.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody } from './http.js'

const LISTING_TIMEOUT_MS = 15000
const TURN_TIMEOUT_MS = 300000

function headersFor(credential, accept) {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${credential.apiKey}`,
    'accept': accept,
    'user-agent': 'dsh-our-free-model',
  }
}

/** One listing round: `GET {base}/models`. Returns the parsed JSON document. */
export async function fetchSealedListing(credential, { signal, timeoutMs = LISTING_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await fetch(`${credential.base}/models`, { headers: headersFor(credential, 'application/json'), redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 200) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('model listing timed out', CODE.timeout)
    throw new UpstreamError(`model listing failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * POST one turn and stream back decoded SSE `data:` payloads.
 *
 * Mirrors the free lane's poster byte-for byte in discipline — body-shape sniff
 * before believing the Content-Type, head replay so no token is buffered — and
 * drops everything the free lane needs that this relay does not: session
 * fingerprints, request ids, the pooled-credential UA.
 */
export async function postSealedStreamed({ credential, body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  let response
  try {
    response = await fetch(`${credential.base}/chat/completions`, {
      method: 'POST',
      headers: headersFor(credential, 'text/event-stream'),
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${error?.message ?? error}`, CODE.transport)
  }

  // `Retry-After` is seconds on the wire and milliseconds in the classified
  // failure — the free lane's poster converts before classifying, so does this.
  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, 4096, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A relay that answered a stream request with one JSON document: fold the
  // whole answer into a single payload for the reader, as the free lane does.
  let text = head.text
  if (!head.done) {
    try {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    } catch (error) {
      await head.reader.cancel().catch(() => {})
      throw classifyStreamFailure(error, signal)
    }
  }
  text += head.decoder.decode()
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`unexpected non-stream response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyFailure(response.status, payload)
  onData(JSON.stringify(payload))
  return { status: response.status }
}
