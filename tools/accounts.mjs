import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

const derive = promisify(scrypt)
const hashToken = (token) => createHash('sha256').update(token).digest('hex')
const randomToken = () => randomBytes(32).toString('base64url')
const DAY = 86400000
const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : ''

export function openAccounts(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  chmodSync(filename, 0o600)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts (
      email TEXT PRIMARY KEY, password TEXT, salt TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS invitations (
      hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES accounts(email), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES accounts(email), expires INTEGER NOT NULL
    );
  `)
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function cleanup() {
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
    db.prepare('DELETE FROM invitations WHERE expires <= ?').run(Date.now())
  }
  return {
    close: () => db.close(),
    invite(rawEmail) {
      const email = normalizeEmail(rawEmail)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Provide a valid email address.')
      cleanup()
      const token = randomToken()
      transaction(() => {
        db.prepare('INSERT INTO accounts(email) VALUES (?) ON CONFLICT(email) DO UPDATE SET enabled = 1, password = NULL, salt = NULL').run(email)
        db.prepare('DELETE FROM invitations WHERE email = ?').run(email)
        db.prepare('DELETE FROM sessions WHERE email = ?').run(email)
        db.prepare('INSERT INTO invitations VALUES (?, ?, ?)').run(hashToken(token), email, Date.now() + DAY)
      })
      return token
    },
    revoke(rawEmail) {
      const email = normalizeEmail(rawEmail)
      transaction(() => {
        db.prepare('UPDATE accounts SET enabled = 0 WHERE email = ?').run(email)
        db.prepare('DELETE FROM sessions WHERE email = ?').run(email)
        db.prepare('DELETE FROM invitations WHERE email = ?').run(email)
      })
    },
    async activate(token, rawEmail, password) {
      const email = normalizeEmail(rawEmail)
      if (typeof token !== 'string' || token.length > 100 || typeof password !== 'string' || password.length < 12 || password.length > 128) return false
      const invitation = db.prepare('SELECT email FROM invitations WHERE hash = ? AND expires > ?').get(hashToken(token), Date.now())
      if (!invitation || invitation.email !== email) return false
      const salt = randomBytes(16).toString('hex')
      const hash = (await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 })).toString('hex')
      return transaction(() => {
        // Check again after password hashing: another request may have consumed or revoked the invite.
        const consumed = db.prepare('DELETE FROM invitations WHERE hash = ? AND email = ? AND expires > ? AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND enabled = 1)').run(hashToken(token), email, Date.now(), email)
        if (consumed.changes !== 1) return false
        db.prepare('UPDATE accounts SET password = ?, salt = ? WHERE email = ?').run(hash, salt, email)
        db.prepare('DELETE FROM sessions WHERE email = ?').run(email)
        return true
      })
    },
    async login(rawEmail, password) {
      const email = normalizeEmail(rawEmail)
      if (typeof password !== 'string' || password.length > 128) return null
      const account = db.prepare('SELECT * FROM accounts WHERE email = ? AND enabled = 1').get(email)
      // Unknown accounts perform the same expensive password derivation.
      const actual = await derive(password, account?.salt ?? '00000000000000000000000000000000', 64, { N: 32768, maxmem: 64 * 1024 * 1024 })
      if (!account?.password || !timingSafeEqual(actual, Buffer.from(account.password, 'hex'))) return null
      // A CLI revocation or password reset can happen during the async derivation.
      const current = db.prepare('SELECT password, enabled FROM accounts WHERE email = ?').get(email)
      if (!current?.enabled || current.password !== account.password) return null
      cleanup()
      const token = randomToken()
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), email, Date.now() + 7 * DAY)
      return token
    },
    session(token) {
      if (!token || token.length > 100) return null
      return db.prepare('SELECT a.email FROM sessions s JOIN accounts a ON a.email = s.email WHERE s.hash = ? AND s.expires > ? AND a.enabled = 1').get(hashToken(token), Date.now()) ?? null
    },
    logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE hash = ?').run(hashToken(token)) },
  }
}
