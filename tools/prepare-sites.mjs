import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = process.cwd()
const config = JSON.parse(readFileSync(resolve(root, '.openai/hosting.json'), 'utf8'))
if (config.d1 !== null || config.r2 !== null) throw new Error('This browser-only build does not use database or object storage.')
for (const folder of ['server', '.openai']) mkdirSync(resolve(root, 'sites-dist', folder), { recursive: true })
for (const [source, target] of [
  ['sites/worker.mjs', 'server/index.js'],
  ['.openai/hosting.json', '.openai/hosting.json'],
  ['sites/privacy.html', 'client/privacy.html'],
  ['hosted/style.css', 'client/privacy.css'],
]) copyFileSync(resolve(root, source), resolve(root, 'sites-dist', target))
console.log('Prepared Sites worker, dashboard, and privacy page.')
