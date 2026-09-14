import { resolve } from 'node:path'
import { openAccounts } from './accounts.mjs'

const [email, option] = process.argv.slice(2)
if (!email || (option && option !== '--revoke')) {
  console.error('Usage: npm run invite -- person@example.com [--revoke]')
  process.exit(1)
}
const configuredUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL
if (!configuredUrl && option !== '--revoke') {
  console.error('Set APP_URL to your hosted URL (or http://localhost:4174 for local testing).')
  process.exit(1)
}
const accounts = openAccounts(resolve(process.env.DATA_DIR || 'data', 'accounts.sqlite'))
try {
  if (option === '--revoke') {
    accounts.revoke(email)
    console.log('Access revoked and existing sessions signed out.')
  } else {
    const url = new URL('/login', configuredUrl)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('APP_URL must use HTTPS except on localhost.')
    url.hash = new URLSearchParams({ invite: accounts.invite(email), email }).toString()
    console.log('Private invitation — expires in 24 hours, usable once. Share only with the invited person:')
    console.log(url.href)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally { accounts.close() }
