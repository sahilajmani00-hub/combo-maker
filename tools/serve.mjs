/**
 * Double-click launcher backend.
 *
 * Serves the built app over http (rather than file://) so canvas exports and
 * module loading behave exactly as they do in development, rebuilds only when
 * something under src/ actually changed, then opens the browser.
 *
 * It also hosts the /api/ai routes behind the AI angle-combos section. Those
 * live here rather than in the browser for two reasons: Higgsfield credentials
 * must never be shipped to a page anyone can open devtools on, and only a
 * process with filesystem access can write the master folder and its per-combo
 * subfolders straight to disk.
 *
 * Deliberately dependency-free: it must still run if node_modules is missing.
 */

import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimate, probeModels, readCredentials, verifyCredentials, writeCredentials } from './higgsfield.mjs'
import * as airun from './airun.mjs'
import * as openrouter from './openrouter.mjs'
import * as queue from './queue.mjs'
import * as templates from './templates.mjs'

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

/** Largest /api/ai/runs body we will read: 60 downscaled photos plus overhead. */
const MAX_BODY_BYTES = 96 * 1024 * 1024

/** Hands a URL or a folder path to the desktop to open. */
function openExternal(target) {
  if (process.platform === 'win32') {
    // The empty string is `start`'s title argument; without it a quoted URL is
    // mistaken for the window title.
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
  }
}

/* ---------------- /api/ai ---------------- */

/**
 * The extension is a different origin (chrome-extension://…), so the queue
 * routes have to say so explicitly. The server binds 127.0.0.1, so the only
 * callers that can reach it are already on this machine.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...CORS,
  })
  response.end(payload)
}

/** Reads a JSON body, refusing anything that would blow the process up. */
function readJson(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Those photos are too large to send in one run.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`Could not read the request: ${error.message}`))
      }
    })
    request.on('error', reject)
  })
}

/** Enough of the key to recognise, never enough to use. */
function maskKey(keyId) {
  return keyId.length > 8 ? `${keyId.slice(0, 4)}...${keyId.slice(-4)}` : '****'
}

/**
 * Model access is per account and does not change during a session, so the
 * probe runs once and is reused - it is four HTTP calls, and the panel asks for
 * the config on every render.
 */
let availabilityCache = null

async function modelAvailability(credentials) {
  if (!credentials) return {}
  if (availabilityCache) return availabilityCache
  availabilityCache = await probeModels(
    credentials,
    Object.entries(airun.MODELS).map(([id, model]) => ({ id, endpoint: model.endpoint })),
  )
  return availabilityCache
}

async function configPayload() {
  const credentials = readCredentials(root)
  const availability = await modelAvailability(credentials)
  return {
    configured: Boolean(credentials),
    keyId: credentials ? maskKey(credentials.keyId) : null,
    fromEnvironment: Boolean(process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
    defaultOutputRoot: airun.defaultOutputRoot(root),
    maxJobs: airun.MAX_JOBS,
    describe: {
      configured: Boolean(openrouter.readKey(root)),
      fromEnvironment: Boolean(process.env.OPENROUTER_API_KEY),
      defaultModel: openrouter.DEFAULT_DESCRIBE_MODEL,
      models: openrouter.DESCRIBE_MODELS,
      promptModels: openrouter.PROMPT_MODELS,
      defaultPromptModel: openrouter.DEFAULT_PROMPT_MODEL,
      productsToken: openrouter.PRODUCTS_TOKEN,
    },
    models: Object.entries(airun.MODELS).map(([id, model]) => ({
      id,
      label: model.label,
      note: model.note,
      references: model.references,
      minImages: model.minImages ?? 1,
      maxImages: model.maxImages,
      aspectRatios: model.aspectRatios,
      resolutions: model.resolutions ?? null,
      available: availability[id]?.available ?? true,
      unavailableReason: availability[id]?.reason ?? null,
    })),
  }
}

const IMAGE_FILE = /\.(jpe?g|png|webp)$/i

/** Every image under a folder, newest first, skipping our own references. */
function findImages(directory, found = [], depth = 0) {
  if (depth > 4 || found.length >= 400) return found
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '_references') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) findImages(full, found, depth + 1)
    else if (IMAGE_FILE.test(entry.name)) found.push(full)
    if (found.length >= 400) break
  }
  return found
}

/**
 * Reads finished images and writes a reusable prompt for each.
 *
 * The files stay server-side — sending a few hundred finished photographs out
 * to the browser and back again purely to reach the model would be absurd.
 */
async function reversePrompts(key, model, body) {
  const directory = resolve(String(body.folder ?? '').trim() || queue.getQueue()?.directory || '')
  if (!directory || !existsSync(directory)) {
    const error = new Error('That folder is not there. Point it at where you saved the generated images.')
    error.expected = true
    throw error
  }

  const files = findImages(directory)
  if (!files.length) {
    const error = new Error(`No images found under ${directory}.`)
    error.expected = true
    throw error
  }

  const limit = Math.max(1, Math.min(Number(body.limit) || files.length, files.length))
  const chosen = files.slice(0, limit)
  const results = new Array(chosen.length)

  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(4, chosen.length) }, async () => {
      while (cursor < chosen.length) {
        const index = cursor++
        const file = chosen[index]
        try {
          const type = extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
          const prompt = await openrouter.promptFromImage(key, model, {
            data: readFileSync(file).toString('base64'),
            type,
          })
          results[index] = { file: file.slice(directory.length + 1), prompt, error: null }
        } catch (error) {
          results[index] = { file: file.slice(directory.length + 1), prompt: '', error: error.message }
        }
      }
    }),
  )

  // Written next to the images so the work is not trapped in a browser tab.
  const written = results.filter((entry) => entry.prompt)
  writeFileSync(join(directory, 'prompts-from-images.json'), `${JSON.stringify({ model, results }, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(directory, 'prompts-from-images.txt'),
    results.map((entry) => `=== ${entry.file}\n${entry.prompt || `(failed: ${entry.error})`}\n`).join('\n'),
    'utf8',
  )
  return { model, directory, total: results.length, written: written.length, results }
}

/** Saved setups, so a refresh is not the end of an afternoon's work. */
async function handleTemplates(request, response, pathname, method) {
  try {
    if (pathname === '/api/templates' && method === 'GET') {
      sendJson(response, 200, { templates: templates.listTemplates(root) })
      return true
    }

    if (pathname === '/api/templates' && method === 'POST') {
      const saved = templates.saveTemplate(root, await readJson(request))
      sendJson(response, 200, { saved, templates: templates.listTemplates(root) })
      return true
    }

    const match = /^\/api\/templates\/([\w-]+)(\/delete)?$/.exec(pathname)
    if (match && !match[2] && method === 'GET') {
      sendJson(response, 200, templates.loadTemplate(root, match[1]))
      return true
    }
    if (match && match[2] && method === 'POST') {
      templates.deleteTemplate(root, match[1])
      sendJson(response, 200, { templates: templates.listTemplates(root) })
      return true
    }

    sendJson(response, 404, { error: 'Unknown template route.' })
    return true
  } catch (error) {
    sendJson(response, error.expected ? 400 : 500, { error: error.message })
    if (!error.expected) console.error(`  Template error on ${pathname}:`, error)
    return true
  }
}

/** The queue the browser extension reads while you work on higgsfield.ai. */
async function handleQueue(request, response, pathname, method) {
  try {
    if (pathname === '/api/queue' && method === 'GET') {
      const current = queue.getQueue()
      if (!current) {
        sendJson(response, 404, { error: 'Nothing queued yet — send a queue from Combo Maker first.' })
        return true
      }
      sendJson(response, 200, current)
      return true
    }

    if (pathname === '/api/queue' && method === 'POST') {
      sendJson(response, 200, queue.createQueue(root, await readJson(request)))
      return true
    }

    // Large queues arrive in pieces: begin, append repeatedly, finish.
    if (pathname === '/api/queue/begin' && method === 'POST') {
      sendJson(response, 200, queue.beginQueue(root, await readJson(request)))
      return true
    }
    if (pathname === '/api/queue/append' && method === 'POST') {
      sendJson(response, 200, queue.appendQueue(await readJson(request)))
      return true
    }
    if (pathname === '/api/queue/finish' && method === 'POST') {
      sendJson(response, 200, queue.finishQueue())
      return true
    }

    if (pathname === '/api/queue/item' && method === 'POST') {
      const body = await readJson(request)
      const item = queue.setStatus(String(body.id ?? ''), String(body.status ?? 'pending'))
      if (!item) {
        sendJson(response, 404, { error: 'That queue item is gone.' })
        return true
      }
      sendJson(response, 200, item)
      return true
    }

    if (pathname === '/api/queue/clear' && method === 'POST') {
      sendJson(response, 200, { cleared: queue.clearQueue(root) })
      return true
    }

    if (pathname === '/api/queue/reset' && method === 'POST') {
      const current = queue.resetStatuses()
      if (!current) {
        sendJson(response, 404, { error: 'Nothing queued yet.' })
        return true
      }
      sendJson(response, 200, current)
      return true
    }

    if (pathname === '/api/queue/file' && method === 'GET') {
      const relative = new URL(request.url ?? '/', 'http://localhost').searchParams.get('path')
      const file = queue.referencePath(relative)
      if (!file) {
        response.writeHead(404, CORS).end('Not found')
        return true
      }
      const body = readFileSync(file)
      response.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        ...CORS,
      })
      response.end(body)
      return true
    }

    sendJson(response, 404, { error: 'Unknown queue route.' })
    return true
  } catch (error) {
    sendJson(response, error.expected ? 400 : 500, { error: error.message })
    if (!error.expected) console.error(`  Queue error on ${pathname}:`, error)
    return true
  }
}

/**
 * Returns true when the request was an API call and has been answered.
 *
 * Every route is POST-or-GET only and reads nothing from the filesystem that
 * the user did not name, so there is no CORS surface to widen here - the page
 * and the API are the same origin by construction.
 */
async function handleApi(request, response, pathname) {
  if (!pathname.startsWith('/api/')) return false

  const method = request.method ?? 'GET'
  if (method === 'OPTIONS') {
    response.writeHead(204, CORS).end()
    return true
  }

  if (pathname.startsWith('/api/queue')) return handleQueue(request, response, pathname, method)
  if (pathname.startsWith('/api/templates')) return handleTemplates(request, response, pathname, method)

  const runMatch = /^\/api\/ai\/runs\/([\w-]+)(\/cancel)?$/.exec(pathname)

  try {
    if (pathname === '/api/ai/config' && method === 'GET') {
      sendJson(response, 200, await configPayload())
      return true
    }

    if (pathname === '/api/ai/config' && method === 'POST') {
      const body = await readJson(request)
      const keyId = String(body.keyId ?? '').trim()
      const keySecret = String(body.keySecret ?? '').trim()
      if (!keyId || !keySecret) {
        sendJson(response, 400, { error: 'Both the key ID and the secret are needed.' })
        return true
      }
      // Checked before saving, so a typo is caught here rather than 200
      // generations into a run.
      const check = await verifyCredentials({ keyId, keySecret })
      if (!check.ok) {
        sendJson(response, 400, {
          error: check.status === 401
            ? 'Higgsfield rejected that key ID and secret.'
            : `Could not reach Higgsfield: ${check.message}`,
        })
        return true
      }
      writeCredentials(root, { keyId, keySecret })
      // A different account carries different models, so the probe starts over.
      availabilityCache = null
      sendJson(response, 200, await configPayload())
      return true
    }

    if (pathname === '/api/ai/describe-key' && method === 'POST') {
      const body = await readJson(request)
      const key = String(body.key ?? '').trim()
      if (!key) {
        sendJson(response, 400, { error: 'Paste an OpenRouter key first.' })
        return true
      }
      const check = await openrouter.verifyKey(key)
      if (!check.ok) {
        sendJson(response, 400, { error: check.message })
        return true
      }
      openrouter.writeKey(root, key)
      sendJson(response, 200, await configPayload())
      return true
    }

    if (pathname === '/api/ai/describe' && method === 'POST') {
      const key = openrouter.readKey(root)
      if (!key) {
        sendJson(response, 400, { error: 'Add an OpenRouter key to describe your products.' })
        return true
      }
      const body = await readJson(request)
      const images = Array.isArray(body.images) ? body.images : []
      const model = openrouter.DESCRIBE_MODELS.some((entry) => entry.id === body.model)
        ? body.model
        : openrouter.DEFAULT_DESCRIBE_MODEL

      // One failed caption should not lose the others, so each resolves on its
      // own and the browser shows which ones came back empty.
      const described = await Promise.all(
        images.map(async (image) => {
          try {
            const text = await openrouter.describeImage(key, model, { ...image, subject: body.subject })
            return { id: image.id, text, error: null }
          } catch (error) {
            return { id: image.id, text: '', error: error.message }
          }
        }),
      )
      sendJson(response, 200, { model, described })
      return true
    }

    // One prompt per combo, written by a model that can see that combo.
    if (pathname === '/api/ai/combo-prompts' && method === 'POST') {
      const key = openrouter.readKey(root)
      if (!key) {
        sendJson(response, 400, { error: 'Add an OpenRouter key first.' })
        return true
      }
      const body = await readJson(request)
      const model = openrouter.DESCRIBE_MODELS.some((entry) => entry.id === body.model)
        ? body.model
        : openrouter.DEFAULT_DESCRIBE_MODEL
      const images = Array.isArray(body.images) ? body.images : []

      const written = new Array(images.length)
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(4, images.length) }, async () => {
          while (cursor < images.length) {
            const index = cursor++
            const image = images[index]
            try {
              const prompt = await openrouter.promptForCombo(key, model, {
                data: image.data,
                type: image.type,
                subject: body.subject,
                count: body.count,
              })
              written[index] = { id: image.id, prompt, error: null }
            } catch (error) {
              written[index] = { id: image.id, prompt: '', error: error.message }
            }
          }
        }),
      )
      sendJson(response, 200, { model, written })
      return true
    }

    // Reverse: read finished images off disk and write the prompt for each.
    if (pathname === '/api/ai/reverse' && method === 'POST') {
      const key = openrouter.readKey(root)
      if (!key) {
        sendJson(response, 400, { error: 'Add an OpenRouter key first.' })
        return true
      }
      const body = await readJson(request)
      const model = openrouter.DESCRIBE_MODELS.some((entry) => entry.id === body.model)
        ? body.model
        : openrouter.DEFAULT_DESCRIBE_MODEL
      sendJson(response, 200, await reversePrompts(key, model, body))
      return true
    }

    if (pathname === '/api/ai/write-prompts' && method === 'POST') {
      const key = openrouter.readKey(root)
      if (!key) {
        sendJson(response, 400, { error: 'Add an OpenRouter key to write prompts.' })
        return true
      }
      const body = await readJson(request)
      const model = openrouter.PROMPT_MODELS.some((entry) => entry.id === body.model)
        ? body.model
        : openrouter.DEFAULT_PROMPT_MODEL
      const angles = Array.isArray(body.angles) ? body.angles : []
      if (!angles.length) {
        sendJson(response, 400, { error: 'Pick at least one camera angle first.' })
        return true
      }
      // One call per angle, in parallel — a failure on one angle should not
      // cost the others, so each reports its own outcome.
      const written = await Promise.all(
        angles.map(async (angle) => {
          try {
            const prompt = await openrouter.writeAnglePrompt(key, model, {
              subject: body.subject,
              count: body.count,
              backdrop: angle.backdrop || body.backdrop,
              aspectRatio: body.aspectRatio,
              extra: body.extra,
              angleLabel: angle.label,
              camera: angle.camera,
            })
            return { id: angle.id, prompt, error: null }
          } catch (error) {
            return { id: angle.id, prompt: '', error: error.message }
          }
        }),
      )
      sendJson(response, 200, { model, written })
      return true
    }

    if (pathname === '/api/ai/estimate' && method === 'POST') {
      const credentials = readCredentials(root)
      if (!credentials) {
        sendJson(response, 400, { error: 'Add your Higgsfield API key and secret first.' })
        return true
      }
      const body = await readJson(request)
      const model = airun.MODELS[body.model]
      if (!model) {
        sendJson(response, 400, { error: 'Unknown model.' })
        return true
      }
      sendJson(response, 200, await estimate(credentials, model.endpoint, airun.estimateBody(model, body)))
      return true
    }

    if (pathname === '/api/ai/runs' && method === 'POST') {
      const credentials = readCredentials(root)
      if (!credentials) {
        sendJson(response, 400, { error: 'Add your Higgsfield API key and secret first.' })
        return true
      }
      const body = await readJson(request)
      const created = airun.createRun(root, credentials, body)
      sendJson(response, 200, airun.snapshot(created))
      return true
    }

    if (runMatch && !runMatch[2] && method === 'GET') {
      const found = airun.getRun(runMatch[1])
      if (!found) {
        sendJson(response, 404, { error: 'That run is no longer being tracked.' })
        return true
      }
      sendJson(response, 200, airun.snapshot(found))
      return true
    }

    if (runMatch && runMatch[2] && method === 'POST') {
      sendJson(response, 200, { cancelled: airun.cancelRun(runMatch[1]) })
      return true
    }

    if (pathname === '/api/ai/reveal' && method === 'POST') {
      const body = await readJson(request)
      const target = resolve(String(body.path ?? ''))
      if (!target || !existsSync(target)) {
        sendJson(response, 404, { error: 'That folder is not there any more.' })
        return true
      }
      openExternal(target)
      sendJson(response, 200, { opened: true })
      return true
    }

    sendJson(response, 404, { error: 'Unknown API route.' })
    return true
  } catch (error) {
    // `expected` marks the validation failures worth showing verbatim; anything
    // else is a bug and gets a 500 so it stands out in the console.
    sendJson(response, error.expected ? 400 : 500, { error: error.message })
    if (!error.expected) console.error(`  API error on ${pathname}:`, error)
    return true
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

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (await handleApi(request, response, pathname)) return

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
  openExternal(url)
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

// A queue outlives the launcher, so a restart picks up where you left off.
const restored = queue.restore(root)
if (restored) {
  const left = restored.items.filter((item) => item.status === 'pending').length
  console.log(`  Extension queue: ${restored.folder} - ${left} of ${restored.items.length} still to do.\n`)
}

listen(Number(process.env.PORT) || 4173, 20)

process.on('SIGINT', () => {
  console.log('\n  Combo Maker stopped.')
  process.exit(0)
})
