/**
 * Google Drive: make a folder, put the images in it.
 *
 * Drive has no API-key path — it is OAuth or nothing — but the launcher is
 * already a local web server, which is exactly what Google's desktop flow
 * wants: send the browser to the consent screen, catch the redirect back on
 * localhost, trade the code for a refresh token, and keep that.
 *
 * The scope is `drive.file`, which grants access only to files this app
 * creates. It cannot see, and so cannot damage, anything already in the Drive.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readSetting, writeSettings } from './env.mjs'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Only the files this app creates — never the rest of the Drive. */
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function fail(message) {
  const error = new Error(message)
  error.expected = true
  throw error
}

/* ---------------- credentials ---------------- */

export function readCredentials(root) {
  const clientId = readSetting(root, 'GOOGLE_CLIENT_ID')
  const clientSecret = readSetting(root, 'GOOGLE_CLIENT_SECRET')
  const refreshToken = readSetting(root, 'GOOGLE_REFRESH_TOKEN')
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, refreshToken: refreshToken || null }
}

export function writeClient(root, { clientId, clientSecret }) {
  writeSettings(root, { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret })
}

export function writeRefreshToken(root, refreshToken) {
  writeSettings(root, { GOOGLE_REFRESH_TOKEN: refreshToken })
}

export function forget(root) {
  writeSettings(root, { GOOGLE_REFRESH_TOKEN: '' })
}

/* ---------------- the consent dance ---------------- */

export function authUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // Offline plus consent is what actually returns a refresh token; without
    // them a second authorisation silently comes back without one.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  })
  return `${AUTH_URL}?${params}`
}

async function tokenRequest(body) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    fail(result?.error_description || result?.error || `Google returned ${response.status}.`)
  }
  return result
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const result = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (!result.refresh_token) {
    fail('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.')
  }
  return result.refresh_token
}

/** Access tokens last an hour, so one is kept until it is nearly stale. */
let cachedToken = null

export async function accessToken(credentials) {
  if (!credentials?.refreshToken) fail('Google Drive is not connected yet.')
  if (cachedToken && cachedToken.refreshToken === credentials.refreshToken && cachedToken.expires > Date.now()) {
    return cachedToken.value
  }
  const result = await tokenRequest({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  })
  cachedToken = {
    value: result.access_token,
    refreshToken: credentials.refreshToken,
    expires: Date.now() + Math.max(60, (result.expires_in ?? 3600) - 120) * 1000,
  }
  return cachedToken.value
}

/** Called when the stored token stops working, so the next call re-fetches. */
export function clearTokenCache() {
  cachedToken = null
}

/* ---------------- Drive ---------------- */

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) clearTokenCache()
    fail(result?.error?.message || `Drive returned ${response.status}.`)
  }
  return result
}

/** Drive query strings are single-quoted, so a quote in a name must escape. */
const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Finds the folder if this app made it before, otherwise creates it.
 *
 * Re-running a upload should top up the same folder rather than leaving a
 * trail of "AI combos", "AI combos (1)", "AI combos (2)" behind.
 */
export async function ensureFolder(token, name, parentId) {
  const clauses = [
    `name = '${quote(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    parentId ? `'${quote(parentId)}' in parents` : null,
  ].filter(Boolean)
  const found = await api(token, `/files?q=${encodeURIComponent(clauses.join(' and '))}&fields=files(id,name)&pageSize=1`)
  if (found.files?.length) return found.files[0].id

  const created = await api(token, '/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  })
  return created.id
}

/**
 * The files this app has already put in a folder, as name -> id.
 *
 * The id matters as much as the name: a re-run skips files that are already
 * there, and the listing spreadsheet still needs a URL for them — which can
 * only be built from the id. Returning names alone would silently leave every
 * previously-uploaded product out of the sheet.
 */
export async function listFileEntries(token, parentId) {
  const entries = new Map()
  let pageToken
  do {
    const params = new URLSearchParams({
      q: `'${quote(parentId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await api(token, `/files?${params}`)
    for (const file of page.files ?? []) entries.set(file.name, file.id)
    pageToken = page.nextPageToken
  } while (pageToken)
  return entries
}

/** The files this app has already put in a folder, by name. */
export async function listFileNames(token, parentId) {
  return new Set((await listFileEntries(token, parentId)).keys())
}

/**
 * Uploads one file.
 *
 * Multipart rather than resumable: listing images are a few hundred kilobytes,
 * and resumable would cost an extra round trip per file for no benefit.
 */
export async function uploadFile(token, { file, name, parentId }) {
  const boundary = `combo${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const metadata = JSON.stringify({ name, parents: [parentId] })
  const mime = MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? 'application/octet-stream'

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    readFileSync(file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

  const response = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) clearTokenCache()
    fail(result?.error?.message || `Drive refused ${name} (${response.status}).`)
  }
  return result
}

/* ---------------- walking the local folder ---------------- */

const IMAGE_FILE = /\.(jpe?g|png|webp|gif)$/i

/**
 * Every image under a folder, with the sub-path it sits in.
 *
 * The combo runs nest one folder per combo, and that structure is the whole
 * point of them — so it is mirrored into Drive rather than flattened into one
 * bucket of hundreds of files.
 */
export function findImages(directory, prefix = '', found = [], depth = 0) {
  if (depth > 5) return found
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) findImages(full, prefix ? `${prefix}/${entry.name}` : entry.name, found, depth + 1)
    else if (IMAGE_FILE.test(entry.name)) found.push({ file: full, folder: prefix, name: entry.name })
  }
  return found
}

/**
 * Makes a folder readable by anyone with the link.
 *
 * Flipkart's bulk-listing importer fetches the images itself, from its own
 * servers — it is not signed in as you — so a private folder gives it nothing
 * to read. `drive.file` covers this because the folder is one this app made.
 */
export async function makePublic(token, fileId) {
  const response = await fetch(`${API}/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    fail(result?.error?.message || `Could not share the folder (${response.status}).`)
  }
}

/**
 * The angle order the marketplace should see, hero shot first.
 *
 * Filenames from a combo run end in " - <tag>", and the tag order is the order
 * the angles were picked — straight-on first, which is the plain-white hero
 * image a listing needs as its main picture. Anything unrecognised sorts after
 * these, alphabetically, so a folder of hand-named files still gets a stable
 * and predictable numbering rather than whatever order the disk returned.
 */
const ANGLE_ORDER = ['front', '34-left', '34-right', 'side', 'top', 'macro', 'low', 'angled']

function angleRank(name) {
  const tag = /\s-\s([a-z0-9-]+)\.[a-z0-9]+$/i.exec(name)?.[1]?.toLowerCase()
  const rank = tag ? ANGLE_ORDER.indexOf(tag) : -1
  return rank === -1 ? ANGLE_ORDER.length : rank
}

/**
 * Groups images the way Flipkart's AI auto-fill expects to find them.
 *
 * One folder per SKU, images inside numbered 1, 2, 3 — it ignores any other
 * naming. Two shapes arrive here and both collapse to the same plan: images
 * already sitting in per-combo subfolders use the subfolder as the SKU, and a
 * flat folder of one-image-per-combo files uses each filename as its own SKU.
 */
export function planFlipkartLayout(images) {
  const bySku = new Map()
  for (const image of images) {
    const sku = image.folder || image.name.replace(/\.[a-z0-9]+$/i, '')
    if (!bySku.has(sku)) bySku.set(sku, [])
    bySku.get(sku).push(image)
  }

  return [...bySku].map(([sku, files]) => ({
    sku,
    files: files
      .slice()
      .sort((a, b) => angleRank(a.name) - angleRank(b.name) || a.name.localeCompare(b.name))
      .map((image, index) => ({ ...image, uploadAs: `${index + 1}${extname(image.name).toLowerCase()}` })),
  }))
}

/**
 * A URL a marketplace importer can actually fetch the image bytes from.
 *
 * Three Drive forms exist and only one is safe to hand to a bulk lister.
 * /file/d/<id>/view serves an HTML viewer page, so a consumer expecting an
 * image gets a page of markup. uc?export=view does return the bytes, but only
 * after a 303 whose first hop declares `application/binary` at
 * `content-length: 0` — an importer that checks the content type without
 * following redirects rejects it, and nothing is cacheable because that hop
 * is sent `no-store`.
 *
 * This form answers in one hop with `200 image/png`, the full byte count, and
 * a day of CDN caching, which is what survives an ingestion fetch.
 */
export function directImageUrl(fileId) {
  return `https://lh3.googleusercontent.com/d/${fileId}`
}

export function folderStats(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail('That folder is not there.')
  }
  const images = findImages(directory)
  return { name: basename(directory), images: images.length, subfolders: new Set(images.map((i) => i.folder)).size }
}
