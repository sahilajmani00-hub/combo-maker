/**
 * Double-click launcher backend.
 *
 * Serves the built app over http (rather than file://) so canvas exports and
 * module loading behave exactly as they do in development, rebuilds only when
 * something under src/ actually changed, then opens the browser.
 *
 * Deliberately dependency-free: it must still run if node_modules is missing.
 */

import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const dist = join(root, 'dist')
const entry = join(dist, 'index.html')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** Newest mtime under a path, ignoring the noisy directories. */
function newestMtime(target) {
  if (!existsSync(target)) return 0
  const stats = statSync(target)
  if (!stats.isDirectory()) return stats.mtimeMs
  let newest = 0
  for (const name of readdirSync(target)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    newest = Math.max(newest, newestMtime(join(target, name)))
  }
  return newest
}

/**
 * npm is a shell script on every platform, so it needs shell:true. Args are
 * baked into the command string rather than passed separately — with a shell,
 * a separate args array is concatenated unescaped and Node deprecates it.
 */
function run(command) {
  return spawnSync(command, { cwd: root, stdio: 'inherit', shell: true }).status === 0
}

function ensureBuild() {
  const sources = [join(root, 'src'), join(root, 'index.html'), join(root, 'vite.config.ts'), join(root, 'package.json')]
  const newestSource = Math.max(...sources.map(newestMtime))
  const built = existsSync(entry) ? statSync(entry).mtimeMs : 0

  if (built && built >= newestSource) return true

  console.log(built ? '  Source changed since the last build - rebuilding...\n' : '  First run - building the app...\n')

  if (!existsSync(join(root, 'node_modules'))) {
    console.log('  Installing dependencies (one time, needs internet)...\n')
    if (!run(`${npm} install`)) {
      console.log('\n  Dependency install failed.')
      return built > 0
    }
  }

  if (run(`${npm} run build`)) {
    console.log('')
    return true
  }

  console.log(built ? '\n  Build failed - starting the previous version instead.\n' : '\n  Build failed.\n')
  return built > 0
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // The empty string is `start`'s title argument; without it a quoted URL is
    // mistaken for the window title.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

function serveFile(response, filePath) {
  const body = readFileSync(filePath)
  response.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  })
  response.end(body)
}

const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const target = normalize(join(dist, pathname === '/' ? 'index.html' : pathname))

    // Refuse anything that escapes dist/ via ../ or an absolute path.
    if (target !== dist && !target.startsWith(dist + sep)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    if (existsSync(target) && statSync(target).isFile()) {
      serveFile(response, target)
      return
    }
    serveFile(response, entry)
  } catch (error) {
    response.writeHead(500).end(`Server error: ${error.message}`)
  }
})

/**
 * Announce once, reading the port back from the socket.
 *
 * Registered here rather than as a listen() callback: a callback passed to a
 * failed listen() stays queued and fires on the *next* successful bind, so
 * retrying a busy port would announce every port it tried.
 */
server.on('listening', () => {
  const address = server.address()
  const url = `http://localhost:${typeof address === 'object' && address ? address.port : ''}/`
  console.log('  ------------------------------------------------')
  console.log('   Combo Maker is running')
  console.log(`   ${url}`)
  console.log('')
  console.log('   Keep this window open while you work.')
  console.log('   Close it (or press Ctrl+C) to stop.')
  console.log('  ------------------------------------------------\n')
  openBrowser(url)
})

/** Walk upward from a preferred port until one is free. */
function listen(port, attemptsLeft) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1)
      return
    }
    console.log(`\n  Could not start the server: ${error.message}\n`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1')
}

if (!ensureBuild()) {
  console.log('  Nothing to serve. Run "npm install" then "npm run build" and try again.\n')
  process.exit(1)
}

listen(Number(process.env.PORT) || 4173, 20)

process.on('SIGINT', () => {
  console.log('\n  Combo Maker stopped.')
  process.exit(0)
})
