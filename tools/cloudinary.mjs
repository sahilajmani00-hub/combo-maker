/**
 * Cloudinary uploads, so listing images have a public URL.
 *
 * Flipkart takes image URLs, not files — every listing row needs one for the
 * main image and up to four more. Cloudinary is the host: permanent URLs, a
 * real CDN, and a free tier big enough for a catalogue this size.
 *
 * Signed uploads rather than unsigned presets: the secret stays in the
 * launcher, which is already where the other keys live.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { readSetting, writeSettings } from './env.mjs'

const BASE_URL = process.env.CLOUDINARY_BASE_URL || 'https://api.cloudinary.com/v1_1'

const MEDIA_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function readCredentials(root) {
  const cloudName = readSetting(root, 'CLOUDINARY_CLOUD_NAME')
  const apiKey = readSetting(root, 'CLOUDINARY_API_KEY')
  const apiSecret = readSetting(root, 'CLOUDINARY_API_SECRET')
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null
}

export function writeCredentials(root, { cloudName, apiKey, apiSecret }) {
  writeSettings(root, {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
  })
}

/**
 * Cloudinary's signature: every parameter except the file itself and the key,
 * sorted by name, joined as a query string, with the secret appended and the
 * whole thing SHA-1'd.
 */
export function sign(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  return createHash('sha1').update(payload + apiSecret).digest('hex')
}

/**
 * Pulls all three values out of a pasted CLOUDINARY_URL.
 *
 * The dashboard leads with "API environment variable" —
 * cloudinary://<key>:<secret>@<cloud> — and shows the raw secret behind a
 * reveal, so pasting that whole string into one field is the natural mistake
 * rather than a careless one. Reading it is three lines here and saves the
 * person hunting for which fragment goes in which box.
 */
export function parseEnvironmentUrl(text) {
  const match = /cloudinary:\/\/([^:@\s]+):([^@\s]+)@([^\s/]+)/i.exec(String(text ?? ''))
  return match ? { apiKey: match[1], apiSecret: match[2], cloudName: match[3] } : null
}

/** Public ids have to survive being part of a URL. */
export function safePublicId(name) {
  return String(name ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'image'
}

/**
 * The same treatment for a folder path, segment by segment.
 *
 * Folders land in the delivery URL verbatim, and these carry SKU names — which
 * on this catalogue are built around "&" as the separator, plus spaces. Left
 * alone that yields "…/Two Stars & Bow/2.png": a URL that a spreadsheet
 * truncates at the ampersand and that no importer can fetch. The separator
 * survives as a word in the SKU column; it has no business in the URL.
 */
export function safeFolder(path) {
  return String(path ?? '')
    .split('/')
    .map((segment) => safePublicId(segment))
    .filter(Boolean)
    .join('/')
}

/**
 * Uploads one image and returns its permanent URL.
 *
 * `overwrite` plus a deterministic public id makes this idempotent: running a
 * catalogue twice updates the same URLs instead of littering the account with
 * duplicates, which also means a re-run does not invalidate a listing that is
 * already live.
 */
export async function uploadImage(credentials, { data, file, type, folder, publicId, signal }) {
  // Callers hold an image either as base64 already in memory (canvas combos)
  // or as a staged file on disk (a scanned folder); both end up as one data
  // URI, and the media type has to be the real one — labelling a PNG as JPEG
  // makes Cloudinary store it under the wrong extension, and the URL in the
  // spreadsheet is then a URL for a file that is not there.
  const bytes = data ?? readFileSync(file).toString('base64')
  const mediaType = type || MEDIA_TYPE_BY_EXTENSION[extname(file ?? '').toLowerCase()] || 'image/png'
  const timestamp = Math.floor(Date.now() / 1000)
  const signed = { folder: safeFolder(folder), overwrite: 'true', public_id: safePublicId(publicId), timestamp }
  const body = new URLSearchParams({
    ...signed,
    file: `data:${mediaType};base64,${bytes}`,
    api_key: credentials.apiKey,
    signature: sign(signed, credentials.apiSecret),
  })

  const response = await fetch(`${BASE_URL}/${credentials.cloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(result?.error?.message || `Cloudinary returned ${response.status}.`)
  }
  return { url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height }
}

/**
 * A 1x1 transparent PNG — the smallest thing that can prove an upload works.
 */
const PROBE_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Confirms the credentials by actually uploading with them.
 *
 * The obvious check — the Admin API's resources endpoint — is the wrong one
 * twice over. It authenticates with HTTP Basic, not the signed parameters used
 * everywhere else here, so passing a key and signature as query parameters
 * comes back "Invalid credentials" no matter how correct they are; and it is
 * restricted on free accounts, which are exactly the accounts this runs on.
 * Either way a working account reads as a broken one.
 *
 * Uploading one transparent pixel tests the capability actually needed, over
 * the same signed path a catalogue run uses, and it works on every tier. The
 * pixel goes to a fixed public id and overwrites itself, so repeated checks
 * leave a single stray file rather than a trail of them.
 */
export async function verifyCredentials(credentials) {
  try {
    const { url } = await uploadImage(credentials, {
      data: PROBE_PIXEL,
      type: 'image/png',
      folder: 'combo-maker',
      publicId: 'connection-check',
    })
    return { ok: true, url }
  } catch (error) {
    const message = String(error.message ?? '')
    if (/Invalid Signature/i.test(message)) {
      return { ok: false, message: 'That API secret does not match the key — check both, then try again.' }
    }
    if (/unknown api_key|Invalid api_key|disabled account/i.test(message)) {
      return { ok: false, message: 'Cloudinary does not recognise that API key.' }
    }
    if (/cloud_name|404/i.test(message)) {
      return { ok: false, message: `No Cloudinary account called "${credentials.cloudName}".` }
    }
    return { ok: false, message: `Cloudinary refused the connection: ${message}` }
  }
}
