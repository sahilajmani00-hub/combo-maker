/**
 * The .env file the setup forms write.
 *
 * Two services now keep keys here (Higgsfield and OpenRouter), so reading and
 * rewriting it lives in one place - a writer that clobbered the other service's
 * key would be an annoying bug to chase.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Minimal KEY=VALUE reader - enough for the handful of keys we store. */
function parse(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line)
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return values
}

export function readEnvFile(root) {
  const file = join(root, '.env')
  return existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}
}

/**
 * One value, environment first.
 *
 * A shell export always wins over the file so CI and `export KEY=...` behave
 * the way anyone would expect.
 */
export function readSetting(root, name, cached = readEnvFile(root)) {
  return process.env[name] || cached[name] || ''
}

/** Rewrites only the named keys, leaving every other line in .env untouched. */
export function writeSettings(root, values) {
  const file = join(root, '.env')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const names = Object.keys(values)
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => !names.some((name) => new RegExp(`^\\s*${name}\\s*=`, 'i').test(line)))
    .join('\n')
    .trim()
  const body = [kept, ...names.map((name) => `${name}=${values[name]}`)].filter(Boolean).join('\n')
  writeFileSync(file, `${body}\n`, 'utf8')
  // Best effort: on Windows chmod is a no-op, which is fine.
  try {
    chmodSync(file, 0o600)
  } catch {}
}
