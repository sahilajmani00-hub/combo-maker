/** Cloudflare R2 object uploads using its S3-compatible API. */

import { createHash, createHmac } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { readSetting, writeSettings } from './env.mjs'

const settingNames = {
  accountId: 'CLOUDFLARE_R2_ACCOUNT_ID',
  bucket: 'CLOUDFLARE_R2_BUCKET',
  accessKeyId: 'CLOUDFLARE_R2_ACCESS_KEY_ID',
  secretAccessKey: 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  publicUrl: 'CLOUDFLARE_R2_PUBLIC_URL',
}

const mediaTypeByExtension = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export function readCredentials(root) {
  const credentials = Object.fromEntries(
    Object.entries(settingNames).map(([key, setting]) => [key, readSetting(root, setting)]),
  )
  return Object.values(credentials).every(Boolean) ? credentials : null
}

export function writeCredentials(root, credentials) {
  writeSettings(root, Object.fromEntries(
    Object.entries(settingNames).map(([key, setting]) => [setting, credentials[key] ?? '']),
  ))
}

export function validateCredentials(input) {
  const credentials = Object.fromEntries(
    Object.keys(settingNames).map((key) => [key, String(input?.[key] ?? '').trim()]),
  )
  if (Object.values(credentials).some((value) => !value)) {
    throw new Error('Account ID, bucket, access key, secret key and public URL are all required.')
  }
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(credentials.accountId)) {
    throw new Error('Check the Cloudflare Account ID format.')
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(credentials.bucket)) {
    throw new Error('Bucket names must be 3–63 lowercase letters, numbers or hyphens, and cannot start or end with a hyphen.')
  }
  let publicUrl
  try {
    publicUrl = new URL(credentials.publicUrl)
  } catch {
    throw new Error('Enter the full public base URL, starting with https://.')
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.search || publicUrl.hash) {
    throw new Error('The public base URL must be an HTTPS URL without query parameters or a fragment.')
  }
  credentials.publicUrl = publicUrl.toString().replace(/\/+$/, '')
  return credentials
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function signingKey(secret, date) {
  const dateKey = hmac(`AWS4${secret}`, date)
  const regionKey = hmac(dateKey, 'auto')
  const serviceKey = hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

function encodePath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function safeSegment(value) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'image'
}

export function safeFolder(value) {
  return String(value ?? '').split('/').map(safeSegment).filter(Boolean).join('/')
}

function publicObjectUrl(publicUrl, key) {
  return `${publicUrl}/${encodePath(key)}`
}

/** Upload an existing local file without holding a large ZIP in memory. */
export async function uploadFile(credentials, { path, fileName, folder, type }) {
  const size = statSync(path).size
  if (!size) throw new Error('The ZIP file is empty.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const key = [safeFolder(folder), safeSegment(fileName)].filter(Boolean).join('/')
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`
  const uri = `/${credentials.bucket}/${encodePath(key)}`
  const url = `https://${host}${uri}`
  const contentType = type || 'application/zip'
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/auto/s3/aws4_request`
  const payloadHash = hash.digest('hex')
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n')
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = ['PUT', uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signature = hmac(signingKey(credentials.secretAccessKey, date), stringToSign, 'hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'Content-Length': String(size),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: createReadStream(path),
    duplex: 'half',
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/i.exec(body)?.[1]
    const message = /<Message>([^<]+)<\/Message>/i.exec(body)?.[1]
    throw new Error(message || code || `R2 upload failed (HTTP ${response.status}).`)
  }
  return { url: publicObjectUrl(credentials.publicUrl, key), key }
}

/** Upload one image with an AWS Signature V4 request. */
export async function uploadImage(credentials, { data, fileName, folder, type }) {
  const bytes = Buffer.from(String(data ?? ''), 'base64')
  if (!bytes.length) throw new Error('The image data is empty.')
  const key = [safeFolder(folder), safeSegment(fileName)].filter(Boolean).join('/')
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`
  const uri = `/${credentials.bucket}/${encodePath(key)}`
  const url = `https://${host}${uri}`
  const contentType = type || mediaTypeByExtension[extname(fileName ?? '').toLowerCase()] || 'application/octet-stream'
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/auto/s3/aws4_request`
  const payloadHash = sha256(bytes)
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n')
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = ['PUT', uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signature = hmac(signingKey(credentials.secretAccessKey, date), stringToSign, 'hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: bytes,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/i.exec(body)?.[1]
    const message = /<Message>([^<]+)<\/Message>/i.exec(body)?.[1]
    const details = message || code || `HTTP ${response.status}`
    throw new Error(`${details}${code && message ? ` (${code})` : ''}`)
  }
  return { url: publicObjectUrl(credentials.publicUrl, key), key }
}
