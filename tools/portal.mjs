import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAccounts } from './accounts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
const WINDOW = 15 * 60 * 1000

export function createPortal({ origin, database, assets = resolve(root, 'hosted-dist') }) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('APP_URL must use HTTPS except on localhost.')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_URL must be the site origin, without a path or credentials.')
  const accounts = openAccounts(database)
  const secure = url.protocol === 'https:'
  const cookieName = secure ? '__Host-combo_session' : 'combo_session'
  const attempts = new Map()
  let globalAttempts = { until: 0, count: 0 }
  function limited(email) {
    const now = Date.now()
    if (globalAttempts.until <= now) globalAttempts = { until: now + WINDOW, count: 0 }
    if (++globalAttempts.count > 120) return true
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key)
    const key = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''
    const entry = attempts.get(key) || { until: now + WINDOW, count: 0 }
    attempts.set(key, entry)
    return ++entry.count > 10
  }
  function cookie(token, expires = false) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires ? 0 : 604800}${secure ? '; Secure' : ''}`
  }
  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(data))
  }
  function redirect(response, location) { response.writeHead(303, { Location: location }); response.end() }
  function file(response, target) {
    if (!statSync(target, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404).end('Not found'); return }
    response.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream' })
    response.end(readFileSync(target))
  }
  async function body(request) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Invalid request.')
    let size = 0
    const parts = []
    for await (const part of request) {
      size += part.length
      if (size > 4096) throw new Error('Request is too large.')
      parts.push(part)
    }
    const value = JSON.parse(Buffer.concat(parts).toString())
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.')
    return value
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000')
    try {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname)
      const token = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
      const session = accounts.session(token)
      if (request.method === 'POST') {
        // Exact configured origin prevents CSRF, including login and logout CSRF.
        if (request.headers.origin !== url.origin) { json(response, 403, { error: 'Please submit this request from the dashboard.' }); return }
        if (pathname === '/auth/logout') {
          accounts.logout(token)
          response.setHeader('Set-Cookie', cookie('', true))
          redirect(response, '/login')
          return
        }
        if (pathname !== '/auth/login' && pathname !== '/auth/activate') { json(response, 404, { error: 'Not found.' }); return }
        const data = await body(request)
        if (limited(data.email)) {
          response.setHeader('Retry-After', '900')
          json(response, 429, { error: 'Too many attempts. Please try again in 15 minutes.' })
          return
        }
        if (pathname === '/auth/activate' && !await accounts.activate(data.token, data.email, data.password)) {
          json(response, 400, { error: 'This invitation is invalid, expired, or already used. Check the invited email and use a password of 12–128 characters.' })
          return
        }
        const newToken = await accounts.login(data.email, data.password)
        if (!newToken) { json(response, 401, { error: 'Email or password is incorrect, or access is unavailable.' }); return }
        accounts.logout(token)
        response.setHeader('Set-Cookie', cookie(newToken))
        json(response, 200, { ok: true })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end(); return }
      if (pathname === '/healthz') { json(response, 200, { ok: true }); return }
      if (pathname === '/login') { file(response, resolve(root, 'hosted/login.html')); return }
      if (pathname === '/auth/style.css') { file(response, resolve(root, 'hosted/style.css')); return }
      if (pathname === '/auth/login.js') { file(response, resolve(root, 'hosted/login.js')); return }
      if (pathname === '/privacy.html') { file(response, resolve(root, 'hosted/privacy.html')); return }
      if (!session) {
        if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) json(response, 401, { error: 'Sign in to continue.' })
        else redirect(response, '/login')
        return
      }
      if (pathname === '/auth/session') { json(response, 200, session); return }
      // This service deliberately does not import the single-user local API.
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) { json(response, 404, { error: 'This feature is available in the local app.' }); return }
      const target = resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!target.startsWith(resolve(assets) + sep)) { response.writeHead(403).end('Forbidden'); return }
      file(response, target)
    } catch (error) {
      // Never return filesystem paths, SQL errors, or account internals to visitors.
      json(response, 400, { error: 'Could not process this request. Please try again.' })
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.on('close', () => accounts.close())
  return { server, accounts }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL
  if (!origin) throw new Error('Set APP_URL to the public HTTPS origin, or http://localhost:4174 for local testing.')
  const { server } = createPortal({ origin, database: resolve(process.env.DATA_DIR || 'data', 'accounts.sqlite') })
  server.listen(Number(process.env.PORT) || 4174, process.env.HOST || '0.0.0.0', () => console.log(`Invite-only Combo Maker listening at ${origin}`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())
}
