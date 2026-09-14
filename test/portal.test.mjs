import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { createPortal } from '../tools/portal.mjs'

async function fixture(t, secure = false) {
  const dir = mkdtempSync(join(tmpdir(), 'combo-auth-'))
  const assets = join(dir, 'dist')
  mkdirSync(assets)
  writeFileSync(join(assets, 'index.html'), '<h1>Private dashboard</h1>')
  writeFileSync(join(assets, 'secret.js'), 'private asset')
  const origin = secure ? 'https://combo.example' : 'http://localhost:4174'
  const database = join(dir, 'accounts.sqlite')
  const portal = createPortal({ origin, database, assets })
  portal.server.listen(0, '127.0.0.1')
  await once(portal.server, 'listening')
  const base = `http://127.0.0.1:${portal.server.address().port}`
  t.after(async () => {
    if (portal.server.listening) await new Promise((done) => portal.server.close(done))
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    ...portal, database, origin, assets,
    get: (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }),
    post: (path, data, cookie, source = origin) => fetch(base + path, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: source, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data),
    }),
  }
}
const email = 'member@example.com'
const password = 'my long unique test passphrase'
const sessionCookie = (response) => response.headers.get('set-cookie')?.split(';')[0]

async function activate(f) {
  const token = f.accounts.invite(email)
  const response = await f.post('/auth/activate', { email, password, token })
  assert.equal(response.status, 200)
  return { token, cookie: sessionCookie(response), response }
}

test('anonymous users cannot access dashboard, assets, or APIs; no signup endpoint', async (t) => {
  const f = await fixture(t)
  for (const path of ['/', '/index.html', '/secret.js']) {
    const response = await f.get(path)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/login')
  }
  assert.equal((await f.get('/api/drive')).status, 401)
  assert.equal((await f.get('/auth/session')).status, 401)
  assert.equal((await f.get('/login')).status, 200)
  assert.equal((await f.get('/privacy.html')).status, 200)
  assert.equal((await f.get('/healthz')).status, 200)
  assert.equal((await f.post('/auth/signup', { email, password })).status, 404)
  assert.equal((await f.post('/auth/login', { email, password })).status, 401)
})

test('invitation requires invited email and strong password and can be consumed only once', async (t) => {
  const f = await fixture(t)
  const token = f.accounts.invite(email)
  assert.equal((await f.post('/auth/activate', { email: 'outsider@example.com', password, token })).status, 400)
  assert.equal((await f.post('/auth/activate', { email, password: 'short', token })).status, 400)
  const response = await f.post('/auth/activate', { email: ' MEMBER@example.com ', password, token })
  assert.equal(response.status, 200)
  const cookie = sessionCookie(response)
  assert.match(await (await f.get('/', cookie)).text(), /Private dashboard/)
  assert.equal((await f.get('/secret.js', cookie)).status, 200)
  assert.deepEqual(await (await f.get('/auth/session', cookie)).json(), { email })
  assert.equal((await f.post('/auth/activate', { email, password, token })).status, 400)
  assert.equal((await f.get('/api/drive', cookie)).status, 404)
  assert.equal((await f.get('/..%2faccounts.sqlite', cookie)).status, 403)
})

test('login rejects wrong password; logout invalidates session server-side', async (t) => {
  const f = await fixture(t)
  await activate(f)
  assert.equal((await f.post('/auth/login', { email, password: 'wrong' })).status, 401)
  const login = await f.post('/auth/login', { email, password })
  assert.equal(login.status, 200)
  const cookie = sessionCookie(login)
  assert.equal((await f.get('/', cookie)).status, 200)
  const logout = await f.post('/auth/logout', {}, cookie)
  assert.equal(logout.status, 303)
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await f.get('/', cookie)).status, 303)
})

test('revocation invalidates all sessions and pending invitation', async (t) => {
  const f = await fixture(t)
  const { cookie } = await activate(f)
  const token = f.accounts.invite(email)
  f.accounts.revoke(email)
  assert.equal((await f.get('/', cookie)).status, 303)
  assert.equal((await f.post('/auth/login', { email, password })).status, 401)
  assert.equal((await f.post('/auth/activate', { email, password, token })).status, 400)
})

test('expired invites and sessions fail; reset invalidates old password and sessions', async (t) => {
  const f = await fixture(t)
  let token = f.accounts.invite(email)
  const db = new DatabaseSync(f.database)
  t.after(() => db.close())
  db.exec('UPDATE invitations SET expires = 0')
  assert.equal((await f.post('/auth/activate', { email, password, token })).status, 400)
  const { cookie } = await activate(f)
  db.exec('UPDATE sessions SET expires = 0')
  assert.equal((await f.get('/', cookie)).status, 303)
  const oldLogin = sessionCookie(await f.post('/auth/login', { email, password }))
  token = f.accounts.invite(email)
  const nextPassword = 'a brand new replacement password'
  assert.equal((await f.post('/auth/activate', { email, password: nextPassword, token })).status, 200)
  assert.equal((await f.get('/', oldLogin)).status, 303)
  assert.equal((await f.post('/auth/login', { email, password })).status, 401)
  assert.equal((await f.post('/auth/login', { email, password: nextPassword })).status, 200)
})

test('cross-origin mutations fail and HTTPS cookies have required protections', async (t) => {
  const f = await fixture(t, true)
  const { cookie, response } = await activate(f)
  assert.match(response.headers.get('set-cookie'), /^__Host-combo_session=/)
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(response.headers.get('set-cookie').includes(flag))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  for (const path of ['/auth/login', '/auth/logout', '/auth/activate']) {
    assert.equal((await f.post(path, { email, password }, cookie, 'https://attacker.example')).status, 403)
  }
  assert.equal((await f.get('/', cookie)).status, 200)
})

test('repeated login attempts are rate-limited', async (t) => {
  const f = await fixture(t)
  for (let n = 0; n < 10; n++) assert.equal((await f.post('/auth/login', { email, password: 'wrong' })).status, 401)
  const response = await f.post('/auth/login', { email, password: 'wrong' })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '900')
})

test('account and session persist through server restart; database contains no plain password or tokens', async (t) => {
  const f = await fixture(t)
  const { cookie, token } = await activate(f)
  await new Promise((done) => f.server.close(done))
  const bytes = readFileSync(f.database).toString()
  assert.ok(!bytes.includes(password))
  assert.ok(!bytes.includes(token))
  assert.ok(!bytes.includes(cookie.split('=')[1]))
  const next = createPortal({ origin: f.origin, database: f.database, assets: f.assets })
  next.server.listen(0, '127.0.0.1')
  await once(next.server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${next.server.address().port}/`, { headers: { Cookie: cookie }, redirect: 'manual' })
    assert.equal(response.status, 200)
  } finally { await new Promise((done) => next.server.close(done)) }
})

test('concurrent redemption creates only one account activation', async (t) => {
  const f = await fixture(t)
  const token = f.accounts.invite(email)
  const responses = await Promise.all([f.post('/auth/activate', { email, password, token }), f.post('/auth/activate', { email, password, token })])
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400])
})

test('reinviting a revoked user does not restore their old password or session', async (t) => {
  const f = await fixture(t)
  const { cookie } = await activate(f)
  f.accounts.revoke(email)
  const token = f.accounts.invite(email)
  assert.equal((await f.post('/auth/login', { email, password })).status, 401)
  assert.equal((await f.get('/', cookie)).status, 303)
  assert.equal((await f.post('/auth/activate', { email, password: 'replacement invite password', token })).status, 200)
})
