/**
 * Higgsfield REST client, used only from the launcher process.
 *
 * Higgsfield credentials must never reach the browser — anyone who opens
 * devtools could then spend the account's credits — so every call to the API
 * happens here, behind the local /api/ai routes.
 *
 * Dependency-free like the rest of tools/, using Node's built-in fetch.
 * Reference: https://docs.higgsfield.ai/docs/quickstart
 */

import { readEnvFile, readSetting, writeSettings } from './env.mjs'

const BASE_URL = process.env.HF_BASE_URL || 'https://platform.higgsfield.ai'

/** Terminal states from the request lifecycle; anything else means keep polling. */
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled'])

/** Status codes worth trying again — the rest are the caller's fault and stick. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

export class HiggsfieldError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'HiggsfieldError'
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------- credentials ---------------- */

/**
 * Environment first so CI or a shell export always wins, then the .env file the
 * in-app setup form writes for people who never open a terminal.
 */
export function readCredentials(root) {
  const cached = readEnvFile(root)
  const keyId = readSetting(root, 'HF_API_KEY_ID', cached)
  const keySecret = readSetting(root, 'HF_API_KEY_SECRET', cached)
  return keyId && keySecret ? { keyId, keySecret } : null
}

export function writeCredentials(root, { keyId, keySecret }) {
  writeSettings(root, { HF_API_KEY_ID: keyId, HF_API_KEY_SECRET: keySecret })
}

function authHeaders(credentials) {
  return { Authorization: `Key ${credentials.keyId}:${credentials.keySecret}` }
}

/* ---------------- transport ---------------- */

/** Bare API codes, said the way someone can act on. */
const ERROR_COPY = {
  model_not_found: 'This model is not available on your Higgsfield account.',
  model_blocked: 'Your Higgsfield plan does not include this model.',
  not_enough_credits: 'Your Higgsfield account is out of credits.',
}

async function readError(response) {
  try {
    const body = await response.json()
    if (body && typeof body.detail === 'string') return ERROR_COPY[body.detail] ?? body.detail
    // Validation failures arrive as a list of field problems.
    if (Array.isArray(body?.detail)) {
      return body.detail
        .map((entry) => `${(entry.loc ?? []).slice(1).join('.') || 'body'}: ${entry.msg}`)
        .join('; ')
    }
  } catch {}
  return response.statusText || `HTTP ${response.status}`
}

/**
 * One request with backoff on transient failures.
 *
 * A generation run fires hundreds of these, so a single 502 in the middle must
 * not take the whole batch down.
 */
async function request(url, options = {}, attempts = 4) {
  let delay = 1000
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(url, options)
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (attempt >= attempts) throw new HiggsfieldError(`Could not reach Higgsfield: ${error.message}`, 0)
      await sleep(delay)
      delay *= 2
      continue
    }
    if (response.ok) return response
    if (!RETRYABLE.has(response.status) || attempt >= attempts) {
      throw new HiggsfieldError(await readError(response), response.status)
    }
    // Honour Retry-After when the API sends one, which it does on 429.
    const retryAfter = Number(response.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay)
    delay *= 2
  }
}

/* ---------------- API surface ---------------- */

/**
 * Puts one source photo on Higgsfield's CDN and returns its public URL.
 *
 * Uploads are per *product*, not per generation: ten photos feeding 120 combos
 * are uploaded ten times, not 1,200.
 */
export async function uploadImage(credentials, { data, contentType, signal }) {
  const created = await request(`${BASE_URL}/files/generate-upload-url`, {
    method: 'POST',
    headers: { ...authHeaders(credentials), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType }),
    signal,
  })
  const { upload_url: uploadUrl, public_url: publicUrl, upload_headers: uploadHeaders } = await created.json()

  // The presigned URL is plain storage — sending our API credentials there
  // would leak them to a third party, so only the returned headers go along.
  await request(uploadUrl, {
    method: 'PUT',
    headers: { ...(uploadHeaders || {}), 'Content-Type': contentType },
    body: data,
    signal,
  })
  return publicUrl
}

/**
 * What one generation would cost, without queueing it.
 *
 * Worth asking before a run rather than after: these batches are combos times
 * angles, so the difference between 720p and 1080p is tens of dollars, not
 * cents.
 */
export async function estimate(credentials, endpoint, body) {
  const response = await request(
    `${BASE_URL}/estimate/${endpoint.replace(/^\//, '')}`,
    {
      method: 'POST',
      headers: { ...authHeaders(credentials), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    2,
  )
  const result = await response.json()
  return { credits: Number(result.credits), usd: Number(result.usd) }
}

/** Queues a generation and returns the initial `{ status, request_id, status_url }`. */
export async function submit(credentials, endpoint, body, signal) {
  const response = await request(`${BASE_URL}/${endpoint.replace(/^\//, '')}`, {
    method: 'POST',
    headers: { ...authHeaders(credentials), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  return response.json()
}

/**
 * Polls a queued request to a terminal state.
 *
 * Two seconds, easing out to ten with jitter — the interval the API docs ask
 * for, and jitter matters here because several workers poll at once.
 */
export async function waitForResult(credentials, statusUrl, { signal, timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let delay = 2000
  while (true) {
    await sleep(delay + Math.random() * 500)
    if (signal?.aborted) throw new Error('Cancelled')

    const response = await request(statusUrl, { headers: authHeaders(credentials), signal })
    const result = await response.json()
    if (TERMINAL.has(result.status)) return result
    if (Date.now() > deadline) {
      throw new HiggsfieldError('Higgsfield did not finish this image in time.', 408)
    }
    delay = Math.min(delay * 1.5, 10000)
  }
}

/**
 * Downloads a finished image from the CDN.
 *
 * The content type comes back with it because not every model lets us ask for
 * an output format — for those, the response is what decides the extension.
 */
export async function fetchBinary(url, signal) {
  const response = await request(url, { signal })
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType: (response.headers.get('content-type') || '').split(';')[0].trim(),
  }
}

/**
 * Which of these endpoints the account can actually generate with.
 *
 * Model access is separate from authentication: a valid key still gets 404
 * `model_not_found` for a model the account does not carry, and 423
 * `model_blocked` for one its plan excludes. Posting an empty body is the cheap
 * way to ask - a reachable model answers 422 because `prompt` is missing, and
 * nothing is queued or billed either way.
 */
export async function probeModels(credentials, endpoints) {
  const entries = await Promise.all(
    endpoints.map(async ({ id, endpoint }) => {
      try {
        await request(
          `${BASE_URL}/${endpoint.replace(/^\//, '')}`,
          {
            method: 'POST',
            headers: { ...authHeaders(credentials), 'Content-Type': 'application/json' },
            body: '{}',
          },
          1,
        )
        return [id, { available: true, reason: null }]
      } catch (error) {
        if (error.status === 422) return [id, { available: true, reason: null }]
        if (error.status === 404) return [id, { available: false, reason: 'Not available on this account' }]
        if (error.status === 423) return [id, { available: false, reason: 'Your plan does not include it' }]
        if (error.status === 401) return [id, { available: false, reason: 'Credentials rejected' }]
        // A network blip should not hide a model the account really has.
        return [id, { available: true, reason: null }]
      }
    }),
  )
  return Object.fromEntries(entries)
}

/** Cheap credential check: a bad key fails fast rather than mid-batch. */
export async function verifyCredentials(credentials) {
  try {
    await request(
      `${BASE_URL}/files/generate-upload-url`,
      {
        method: 'POST',
        headers: { ...authHeaders(credentials), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_type: 'image/jpeg' }),
      },
      1,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, status: error.status ?? 0, message: error.message }
  }
}
