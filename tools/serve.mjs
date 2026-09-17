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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { estimate, probeModels, readCredentials, verifyCredentials, writeCredentials } from './higgsfield.mjs'
import * as airun from './airun.mjs'
import * as openrouter from './openrouter.mjs'
import * as queue from './queue.mjs'
import * as templates from './templates.mjs'
import * as drive from './drive.mjs'
import * as cloudinary from './cloudinary.mjs'

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

/** Where Google sends the browser back after consent. */
function redirectUri() {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 4173
  return `http://localhost:${port}/api/drive/callback`
}

/** Progress of the upload currently running, polled by the page. */
let driveRun = null

/**
 * Where the last run's manifest is kept between restarts.
 *
 * The listing sheet is built entirely from that manifest, so holding it only
 * in memory meant restarting the launcher silently threw away the URLs for a
 * finished upload — the sheet button simply disappeared, with the images still
 * sitting in Drive and no way left to get a spreadsheet for them. Several
 * hundred uploads are too expensive to repeat over a process exit.
 */
const RUN_FILE = join(root, '.last-drive-run.json')

function saveRun(run) {
  if (!run?.manifest?.length) return
  try {
    // Explicit field list rather than the whole object: it is the reason no
    // credential can ever reach this file by accident.
    const { status, folder, total, done, skipped, failed, link, error, hosted, hostError, layout, rootId, manifest } = run
    const saved = { status, folder, total, done, skipped, failed, link, error, hosted, hostError, layout, rootId, manifest, savedAt: new Date().toISOString() }
    writeFileSync(RUN_FILE, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
  } catch {
    // Losing the cache is not worth failing an upload over.
  }
}

function loadRun() {
  try {
    if (!existsSync(RUN_FILE)) return null
    const run = JSON.parse(readFileSync(RUN_FILE, 'utf8'))
    if (!run?.manifest?.length) return null
    // Nothing can still be running: the process that was running it is gone.
    // Left as "running" it would block the next upload and poll forever.
    if (run.status === 'running') run.status = 'finished'
    return run
  } catch {
    return null
  }
}

driveRun = loadRun()

/**
 * Mirrors one image to Cloudinary so the spreadsheet has a durable URL.
 *
 * Drive does serve the bytes, but only through lh3.googleusercontent.com,
 * which Google documents nowhere and has broken before — and a bulk listing
 * that is still being assembled days later cannot afford the URLs in it to
 * stop resolving. Cloudinary is the copy meant to outlive the run: documented
 * delivery URLs, a real CDN, and nothing that expires on its own.
 *
 * It stays optional. With no credentials configured every run works exactly
 * as it did and the sheet falls back to the Drive URL, so this is a hardening
 * step rather than a new thing to set up before uploading anything.
 */
/**
 * Folder names claimed by each run, so two SKUs cannot collide.
 *
 * Kept out here rather than on the run object because /api/drive serialises
 * that straight to the page, and a Map would land there as an empty object.
 */
const claimedFolders = new WeakMap()

/**
 * The Cloudinary folder for one SKU, guaranteed unique within its run.
 *
 * Sanitising is lossy — "A & B" and "A-B" both flatten to "A-B" — and uploads
 * overwrite by design, so without this the second SKU would quietly take over
 * the first one's URLs and a listing would go live showing the wrong earrings.
 * A numeric suffix on the loser costs nothing and only appears when two names
 * genuinely collapse together.
 */
function folderFor(run, raw) {
  let claimed = claimedFolders.get(run)
  if (!claimed) claimedFolders.set(run, (claimed = { byRaw: new Map(), taken: new Set() }))
  const existing = claimed.byRaw.get(raw)
  if (existing) return existing

  const base = cloudinary.safeFolder(raw) || 'combo'
  let name = base
  for (let suffix = 2; claimed.taken.has(name); suffix++) name = `${base}-${suffix}`
  claimed.taken.add(name)
  claimed.byRaw.set(raw, name)
  return name
}

/**
 * hostImage, but never fatal.
 *
 * The Drive upload is the part the user is waiting on; the durable copy is a
 * bonus on top of it. So a Cloudinary failure is recorded and the run carries
 * on — losing one mirrored URL is a row to fix, losing the whole upload of
 * several hundred images is an evening.
 */
async function mirror(run, credentials, options) {
  if (!credentials) return null
  try {
    const url = await hostImage(credentials, options)
    run.hosted += 1
    return url
  } catch (error) {
    run.hostError = error.message
    return null
  }
}

async function hostImage(credentials, { folder, name, data, file, type }) {
  if (!credentials) return null
  const uploaded = await cloudinary.uploadImage(credentials, {
    data,
    file,
    type,
    folder: `combo-maker/${folder}`,
    publicId: cloudinary.safePublicId(name),
  })
  return uploaded.url
}

/**
 * Uploads in the shape Flipkart's bulk-listing auto-fill reads.
 *
 * One public master folder, a sub-folder per SKU, and images numbered 1, 2, 3
 * inside each — Flipkart ignores any other filename, so the renaming is not
 * cosmetic. The folder is shared publicly because Flipkart fetches the images
 * from its own servers rather than as the signed-in seller.
 */
async function runFlipkartUpload(token, rootName, images) {
  const plan = drive.planFlipkartLayout(images)
  const total = plan.reduce((sum, group) => sum + group.files.length, 0)
  const myRun = (driveRun = { status: 'running', folder: rootName, total, done: 0, skipped: 0, failed: 0, link: null, error: null })
  myRun.manifest = []
  // Read once per run, not per image: the credentials live in a file.
  const host = cloudinary.readCredentials(root)
  myRun.hosted = 0
  myRun.hostError = null

  const rootId = await drive.ensureFolder(token, rootName, null)
  myRun.link = `https://drive.google.com/drive/folders/${rootId}`
  try {
    await drive.makePublic(token, rootId)
  } catch (error) {
    // Worth continuing — the files still upload, they just are not reachable
    // by Flipkart until the folder is shared by hand.
    myRun.error = `Uploaded, but could not make the folder public: ${error.message}`
  }

  for (const group of plan) {
    if (myRun.status === 'cancelled') break
    try {
      const skuId = await drive.ensureFolder(token, group.sku, rootId)
      const existing = await drive.listFileEntries(token, skuId)
      const entry = { sku: group.sku, images: [] }
      for (const image of group.files) {
        if (myRun.status === 'cancelled') break
        // A file already in Drive still belongs in the spreadsheet, so its id
        // is taken from the listing rather than being uploaded again.
        const already = existing.get(image.uploadAs)
        // A skipped file still needs its durable URL, because the sheet is
        // built from the whole manifest and a re-run into an existing folder
        // would otherwise produce rows with holes in them.
        const hosted = await mirror(myRun, host, {
          folder: folderFor(myRun, `${rootName}/${group.sku}`),
          name: image.uploadAs,
          file: image.file,
        })
        if (already) {
          entry.images.push({ name: image.uploadAs, id: already, url: drive.directImageUrl(already), hosted })
          myRun.skipped += 1
          continue
        }
        const uploaded = await drive.uploadFile(token, { file: image.file, name: image.uploadAs, parentId: skuId })
        entry.images.push({ name: image.uploadAs, id: uploaded.id, url: drive.directImageUrl(uploaded.id), hosted })
        myRun.done += 1
      }
      if (entry.images.length) myRun.manifest.push(entry)
    } catch (error) {
      myRun.failed += group.files.length
      myRun.error = error.message
    }
  }
  if (myRun.status === 'running') myRun.status = 'finished'
  saveRun(myRun)
}

async function runDriveUpload(root, credentials, directory, flipkart = false) {
  const token = await drive.accessToken(credentials)
  const images = drive.findImages(directory)
  const rootName = basename(directory)
  if (flipkart) return runFlipkartUpload(token, rootName, images)
  // Captured once and mutated through this reference for the rest of the
  // function, never through the module-level `driveRun` binding — see the
  // note on `myRun` below for why that distinction matters.
  const myRun = (driveRun = { status: 'running', folder: rootName, total: images.length, done: 0, skipped: 0, failed: 0, link: null, error: null })

  const rootId = await drive.ensureFolder(token, rootName, null)
  myRun.link = `https://drive.google.com/drive/folders/${rootId}`

  // One Drive folder per local subfolder, and the names already in each so a
  // re-run tops the folder up instead of uploading everything twice.
  const folderIds = new Map([['', rootId]])
  const existing = new Map([['', await drive.listFileNames(token, rootId)]])
  const folderFor = async (relative) => {
    if (folderIds.has(relative)) return folderIds.get(relative)
    const parts = relative.split('/')
    const parent = await folderFor(parts.slice(0, -1).join('/'))
    const id = await drive.ensureFolder(token, parts[parts.length - 1], parent)
    folderIds.set(relative, id)
    existing.set(relative, await drive.listFileNames(token, id))
    return id
  }

  for (const image of images) {
    if (myRun.status === 'cancelled') break
    try {
      const parentId = await folderFor(image.folder)
      if (existing.get(image.folder)?.has(image.name)) {
        myRun.skipped += 1
        continue
      }
      await drive.uploadFile(token, { file: image.file, name: image.name, parentId })
      myRun.done += 1
    } catch (error) {
      myRun.failed += 1
      myRun.error = error.message
    }
  }
  if (myRun.status === 'running') myRun.status = 'finished'
  saveRun(myRun)
}

const EXTENSION_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/**
 * Uploads a flat set of in-memory images (base64) into one Drive folder.
 *
 * This is the canvas-combo path: those images only ever exist as blobs in the
 * browser tab, never written to disk, so there is nothing on disk to point
 * `runDriveUpload` at. The images are staged to a scratch temp directory only
 * long enough to hand each one to the same multipart upload `runDriveUpload`
 * uses, then the temp directory is removed.
 */
/**
 * A batched upload of images that only exist in the browser.
 *
 * Canvas combos are never written to disk, so they arrive as base64 over HTTP.
 * At 350 combos with their source photos that is far past any sane request
 * size, so the browser sends them in batches against one open run, the same
 * shape the extension queue uses.
 *
 * Each uploaded file's id is kept, because the spreadsheet that goes to
 * Flipkart needs a fetchable URL per image and that can only be built from the
 * id Drive hands back at upload time.
 */
async function startDriveImageRun(credentials, folderName, layout) {
  // Drive gives the folder structure Flipkart's auto-fill reads; Cloudinary
  // gives the URLs. Either alone is a useful run, so a disconnected Drive no
  // longer blocks getting a listing sheet out of a finished batch of combos.
  const useDrive = Boolean(credentials?.refreshToken)
  const myRun = (driveRun = {
    status: 'running',
    folder: folderName,
    total: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    link: null,
    error: null,
  })

  myRun.useDrive = useDrive
  myRun.layout = layout
  myRun.manifest = []
  myRun.hosted = 0
  myRun.hostError = null

  if (useDrive) {
    const token = await drive.accessToken(credentials)
    const rootId = await drive.ensureFolder(token, folderName, null)
    myRun.link = `https://drive.google.com/drive/folders/${rootId}`
    myRun.rootId = rootId
    if (layout !== 'flat') {
      try {
        await drive.makePublic(token, rootId)
      } catch (error) {
        myRun.error = `Uploading, but could not make the folder public: ${error.message}`
      }
    }
  }
  return myRun
}

async function uploadDriveImageBatch(credentials, groups) {
  if (!driveRun || driveRun.status !== 'running') {
    const error = new Error('No upload is open — start one first.')
    error.expected = true
    throw error
  }
  const myRun = driveRun
  const token = myRun.useDrive ? await drive.accessToken(credentials) : null
  // Deliberately not cached on the run: /api/drive serialises that object
  // straight to the page, and the API secret has no business going there.
  const host = cloudinary.readCredentials(root)
  const staging = mkdtempSync(join(tmpdir(), 'combo-maker-drive-'))

  try {
    for (const group of groups) {
      if (myRun.status === 'cancelled') break
      const flat = myRun.layout === 'flat'
      const sku = String(group.sku ?? 'combo')
      let parentId = myRun.rootId
      try {
        if (token && !flat) parentId = await drive.ensureFolder(token, sku, myRun.rootId)
      } catch (error) {
        myRun.failed += group.files.length
        myRun.error = error.message
        continue
      }

      const entry = { sku, images: [] }
      for (const [index, image] of group.files.entries()) {
        if (myRun.status === 'cancelled') break
        try {
          const extension = EXTENSION_BY_MIME[image.type] ?? 'jpg'
          // Flipkart only reads images numbered 1, 2, 3 inside the SKU folder.
          const uploadName = flat ? image.name : `${index + 1}.${extension}`
          let uploaded = null
          if (token) {
            const stagedPath = join(staging, `${myRun.done + myRun.failed}-${index}.${extension}`)
            writeFileSync(stagedPath, Buffer.from(String(image.data ?? ''), 'base64'))
            uploaded = await drive.uploadFile(token, { file: stagedPath, name: uploadName, parentId })
          }
          const hosted = await mirror(myRun, host, {
            folder: folderFor(myRun, flat ? myRun.folder : `${myRun.folder}/${sku}`),
            name: flat ? uploadName : String(index + 1),
            data: String(image.data ?? ''),
            type: image.type,
          })
          // Without Drive the hosted URL is the only one there is, so it fills
          // both columns rather than leaving the row half empty.
          entry.images.push({
            name: uploadName,
            id: uploaded?.id ?? null,
            url: uploaded ? drive.directImageUrl(uploaded.id) : hosted,
            hosted,
          })
          myRun.done += 1
        } catch (error) {
          myRun.failed += 1
          myRun.error = error.message
        }
      }
      if (entry.images.length) myRun.manifest.push(entry)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  // Saved per batch, not only at the end: a 350-combo run that dies halfway
  // should still yield a sheet for the part that reached Drive.
  saveRun(myRun)
  return { done: myRun.done, failed: myRun.failed }
}

/**
 * Cloudinary: the durable home for listing image URLs.
 *
 * Only ever reports whether a cloud name is configured, never the key or the
 * secret — those go in one direction, from the page into the settings file.
 */
async function handleCloudinary(request, response, pathname, method) {
  try {
    if (pathname === '/api/cloudinary' && method === 'GET') {
      const credentials = cloudinary.readCredentials(root)
      sendJson(response, 200, {
        configured: Boolean(credentials),
        cloudName: credentials?.cloudName ?? '',
        // Enough of the key to recognise the account, never enough to use it.
        apiKeyHint: credentials ? `…${credentials.apiKey.slice(-4)}` : '',
      })
      return true
    }

    if (pathname === '/api/cloudinary' && method === 'POST') {
      const body = await readJson(request)
      // Any one of the three fields may hold the whole environment URL; if it
      // does, it carries all three and is more trustworthy than the rest.
      const pasted =
        cloudinary.parseEnvironmentUrl(body.cloudName) ??
        cloudinary.parseEnvironmentUrl(body.apiKey) ??
        cloudinary.parseEnvironmentUrl(body.apiSecret)
      const cloudName = pasted?.cloudName ?? String(body.cloudName ?? '').trim()
      const apiKey = pasted?.apiKey ?? String(body.apiKey ?? '').trim()
      const apiSecret = pasted?.apiSecret ?? String(body.apiSecret ?? '').trim()
      if (!cloudName || !apiKey || !apiSecret) {
        sendJson(response, 400, { error: 'Cloud name, API key and API secret are all needed.' })
        return true
      }
      const check = await cloudinary.verifyCredentials({ cloudName, apiKey, apiSecret })
      if (!check.ok) {
        sendJson(response, 400, { error: check.message })
        return true
      }
      cloudinary.writeCredentials(root, { cloudName, apiKey, apiSecret })
      sendJson(response, 200, {
        configured: true,
        cloudName,
        apiKeyHint: `…${apiKey.slice(-4)}`,
        // The probe image that proved the upload works — shown as evidence
        // rather than asking the user to take "connected" on trust.
        checkUrl: check.url ?? null,
      })
      return true
    }

    /**
     * Direct URLs for the raw product photos — the images in the Add
     * products panel, before any combo is built from them.
     *
     * Independent of Drive and of any combo run: this is just "host these
     * files, hand back their URLs," useful on its own for pasting a source
     * photo's link somewhere, or checking one before it goes into a combo.
     */
    if (pathname === '/api/cloudinary/products' && method === 'POST') {
      const credentials = cloudinary.readCredentials(root)
      if (!credentials) {
        sendJson(response, 400, { error: 'Connect Cloudinary first — the panel is under Add products.' })
        return true
      }
      const body = await readJson(request)
      const files = Array.isArray(body.files) ? body.files : []
      if (!files.length) {
        sendJson(response, 400, { error: 'No images to upload.' })
        return true
      }
      const folder = `combo-maker/products/${cloudinary.safeFolder(String(body.folder ?? 'uploads')) || 'uploads'}`
      // Two source photos can share a name (a rename, or two sellers'
      // "IMG_0001"); a collision here would silently overwrite one image's
      // URL with the other's, so duplicates get the same numbered suffix the
      // zip download already uses.
      const used = new Set()
      const results = []
      for (const file of files) {
        const name = String(file?.name ?? 'image')
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        // Dedupe on the SANITISED id, not the raw stem: "A & B" and "A-B" are
        // different names but collapse to the same Cloudinary public_id, and
        // an unguarded collision there would silently overwrite one photo's
        // asset with the other's under the URL already handed back for it.
        let publicId = stem
        while (used.has(cloudinary.safePublicId(publicId))) {
          const match = /^(.*) \((\d+)\)$/.exec(publicId)
          publicId = match ? `${match[1]} (${Number(match[2]) + 1})` : `${stem} (2)`
        }
        used.add(cloudinary.safePublicId(publicId))
        try {
          const uploaded = await cloudinary.uploadImage(credentials, {
            data: String(file?.data ?? ''),
            type: file?.type,
            folder,
            publicId,
          })
          results.push({ name, url: uploaded.url })
        } catch (error) {
          results.push({ name, error: error.message })
        }
      }
      sendJson(response, 200, { results })
      return true
    }

    if (pathname === '/api/cloudinary/disconnect' && method === 'POST') {
      cloudinary.writeCredentials(root, { cloudName: '', apiKey: '', apiSecret: '' })
      sendJson(response, 200, { configured: false, cloudName: '' })
      return true
    }

    return false
  } catch (error) {
    sendJson(response, error.expected ? 400 : 500, { error: error.message })
    return true
  }
}

/** Google Drive: connect once, then mirror a folder of images into it. */
async function handleDrive(request, response, pathname, method) {
  try {
    if (pathname === '/api/drive' && method === 'GET') {
      const credentials = drive.readCredentials(root)
      sendJson(response, 200, {
        hasClient: Boolean(credentials),
        connected: Boolean(credentials?.refreshToken),
        redirectUri: redirectUri(),
        run: driveRun,
      })
      return true
    }

    if (pathname === '/api/drive/client' && method === 'POST') {
      const body = await readJson(request)
      const clientId = String(body.clientId ?? '').trim()
      const clientSecret = String(body.clientSecret ?? '').trim()
      if (!clientId || !clientSecret) {
        sendJson(response, 400, { error: 'Both the client ID and the secret are needed.' })
        return true
      }
      drive.writeClient(root, { clientId, clientSecret })
      sendJson(response, 200, { authUrl: drive.authUrl(clientId, redirectUri()) })
      return true
    }

    // Google redirects the browser here with ?code=... after consent.
    if (pathname === '/api/drive/callback' && method === 'GET') {
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      const page = (title, detail) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:14px system-ui;padding:48px;max-width:36em">` +
        `<h2 style="font-weight:600">${title}</h2><p style="color:#555">${detail}</p></body>`
      try {
        const credentials = drive.readCredentials(root)
        if (!credentials) throw new Error('No Google client is saved.')
        if (query.get('error')) throw new Error(query.get('error'))
        const refreshToken = await drive.exchangeCode({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          code: query.get('code') ?? '',
          redirectUri: redirectUri(),
        })
        drive.writeRefreshToken(root, refreshToken)
        drive.clearTokenCache()
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(page('Google Drive connected', 'You can close this tab and go back to Combo Maker.'))
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(page('Could not connect Google Drive', error.message))
      }
      return true
    }

    /**
     * Consent again using the client already on file.
     *
     * Disconnecting clears only the refresh token; the OAuth client survives
     * in the settings file. Without this the sole way back is retyping an ID
     * and secret the launcher can already see, which is a needless trip to the
     * Google console after a single mis-click.
     */
    if (pathname === '/api/drive/reconnect' && method === 'POST') {
      const credentials = drive.readCredentials(root)
      if (!credentials?.clientId) {
        sendJson(response, 400, { error: 'No OAuth client saved yet — paste the ID and secret once.' })
        return true
      }
      sendJson(response, 200, { authUrl: drive.authUrl(credentials.clientId, redirectUri()) })
      return true
    }

    if (pathname === '/api/drive/disconnect' && method === 'POST') {
      drive.forget(root)
      drive.clearTokenCache()
      sendJson(response, 200, { connected: false })
      return true
    }

    if (pathname === '/api/drive/scan' && method === 'POST') {
      const body = await readJson(request)
      sendJson(response, 200, drive.folderStats(resolve(String(body.folder ?? '').trim())))
      return true
    }

    if (pathname === '/api/drive/images/start' && method === 'POST') {
      const credentials = drive.readCredentials(root)
      // Either destination is enough on its own: Drive for the folder layout,
      // Cloudinary for the URLs the listing sheet is made of.
      if (!credentials?.refreshToken && !cloudinary.readCredentials(root)) {
        sendJson(response, 400, { error: 'Connect Google Drive or Cloudinary first.' })
        return true
      }
      if (driveRun?.status === 'running') {
        sendJson(response, 400, { error: 'An upload is already running.' })
        return true
      }
      const body = await readJson(request)
      const run = await startDriveImageRun(
        credentials,
        String(body.folderName ?? '').trim() || 'Combo Maker exports',
        String(body.layout ?? 'combo'),
      )
      sendJson(response, 200, { started: true, folder: run.folder, link: run.link })
      return true
    }

    if (pathname === '/api/drive/images/batch' && method === 'POST') {
      const credentials = drive.readCredentials(root)
      const body = await readJson(request)
      const groups = Array.isArray(body.groups) ? body.groups : []
      if (driveRun?.status === 'running') driveRun.total += groups.reduce((sum, g) => sum + (g.files?.length ?? 0), 0)
      sendJson(response, 200, await uploadDriveImageBatch(credentials, groups))
      return true
    }

    if (pathname === '/api/drive/images/done' && method === 'POST') {
      if (driveRun?.status === 'running') driveRun.status = 'finished'
      saveRun(driveRun)
      sendJson(response, 200, { run: driveRun })
      return true
    }

    // The spreadsheet Flipkart's bulk listing wants: one row per SKU, each
    // image as a URL it can actually fetch.
    if (pathname === '/api/drive/sheet.xlsx' && method === 'GET') {
      const manifest = driveRun?.manifest
      if (!manifest?.length) {
        sendJson(response, 404, { error: 'Nothing uploaded yet — run a Drive upload first.' })
        return true
      }
      let XLSX
      try {
        XLSX = (await import('xlsx')).default
      } catch {
        sendJson(response, 500, { error: 'The xlsx package is missing — run "npm install" and restart.' })
        return true
      }

      const widest = Math.max(...manifest.map((entry) => entry.images.length))
      const header = ['SKU', 'Hero Image URL']
      for (let index = 2; index <= widest; index++) header.push(`Image ${index} URL`)
      header.push('Public Folder URL')

      const rows = [header]
      for (const entry of manifest) {
        const row = [entry.sku]
        // The mirrored URL is the one meant to be pasted into a listing; the
        // Drive URL is what there is when Cloudinary was not configured or
        // that one image failed to mirror.
        for (let index = 0; index < widest; index++) {
          const image = entry.images[index]
          row.push(image?.hosted || image?.url || '')
        }
        row.push(driveRun.link ?? '')
        rows.push(row)
      }

      const book = XLSX.utils.book_new()
      const sheet = XLSX.utils.aoa_to_sheet(rows)
      sheet['!cols'] = header.map((name, index) => ({ wch: index === 0 ? 34 : 58 }))
      XLSX.utils.book_append_sheet(book, sheet, 'Listings')
      const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'buffer' })

      response.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${(driveRun.folder || 'combo-maker').replace(/[^\w.-]+/g, '-')}-listings.xlsx"`,
        'Content-Length': buffer.length,
        ...CORS,
      })
      response.end(buffer)
      return true
    }

    if (pathname === '/api/drive/upload' && method === 'POST') {
      const credentials = drive.readCredentials(root)
      if (!credentials?.refreshToken) {
        sendJson(response, 400, { error: 'Connect Google Drive first.' })
        return true
      }
      if (driveRun?.status === 'running') {
        sendJson(response, 400, { error: 'An upload is already running.' })
        return true
      }
      const body = await readJson(request)
      const directory = resolve(String(body.folder ?? '').trim())
      // Fails here if the folder is wrong, rather than after answering OK.
      const stats = drive.folderStats(directory)
      // Not awaited: the browser follows progress by polling.
      runDriveUpload(root, credentials, directory, Boolean(body.flipkart)).catch((error) => {
        driveRun = { ...(driveRun ?? {}), status: 'failed', error: error.message }
      })
      sendJson(response, 200, { started: true, ...stats })
      return true
    }

    if (pathname === '/api/drive/cancel' && method === 'POST') {
      if (driveRun?.status === 'running') driveRun.status = 'cancelled'
      saveRun(driveRun)
      sendJson(response, 200, { run: driveRun })
      return true
    }

    sendJson(response, 404, { error: 'Unknown Drive route.' })
    return true
  } catch (error) {
    sendJson(response, error.expected ? 400 : 500, { error: error.message })
    if (!error.expected) console.error(`  Drive error on ${pathname}:`, error)
    return true
  }
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

    // Surfaces and camera clauses, handed over by the dashboard because that is
    // where the prompt wording lives. Offered on every load, so a queue built
    // before this existed still gets the choice.
    if (pathname === '/api/queue/wording' && method === 'POST') {
      sendJson(response, 200, queue.setWording(await readJson(request)))
      return true
    }

    // Which vision models can be asked to rewrite one image's prompt.
    if (pathname === '/api/queue/models' && method === 'GET') {
      sendJson(response, 200, {
        models: openrouter.DESCRIBE_MODELS,
        defaultModel: openrouter.DEFAULT_DESCRIBE_MODEL,
        ready: Boolean(openrouter.readKey(root)),
      })
      return true
    }

    /**
     * Has a model look at this item's own reference pictures and write its
     * prompt from scratch.
     *
     * The pictures are read from disk here rather than sent up from the panel:
     * the launcher already has them, and a composite is a few hundred kilobytes
     * that has no business making a round trip through the browser.
     */
    if (pathname === '/api/queue/item/recreate' && method === 'POST') {
      const key = openrouter.readKey(root)
      if (!key) {
        sendJson(response, 400, { error: 'Add an OpenRouter key in Combo Maker first — the AI tab, under Describe.' })
        return true
      }
      const body = await readJson(request)
      const files = queue.referencesFor(String(body.id ?? ''))
      if (!files) {
        sendJson(response, 404, { error: 'That queue item is gone.' })
        return true
      }
      if (!files.length) {
        sendJson(response, 400, { error: 'This item has no reference picture for a model to read.' })
        return true
      }
      const model = openrouter.DESCRIBE_MODELS.some((entry) => entry.id === body.model)
        ? body.model
        : openrouter.DEFAULT_DESCRIBE_MODEL
      const written = await openrouter.promptForCombo(key, model, {
        images: files.map((file) => ({
          data: readFileSync(file).toString('base64'),
          type: MIME[extname(file).toLowerCase()] ?? 'image/jpeg',
        })),
        subject: queue.getQueue()?.subject,
        count: queue.getQueue()?.comboSize,
      })
      sendJson(response, 200, queue.setWrittenPrompt(String(body.id), written, model))
      return true
    }

    if (pathname === '/api/queue/item/prompt' && method === 'POST') {
      const body = await readJson(request)
      const item = queue.setPrompt(String(body.id ?? ''), body.prompt)
      if (!item) {
        sendJson(response, 404, { error: 'That queue item is gone.' })
        return true
      }
      sendJson(response, 200, item)
      return true
    }

    // Atmosphere — haze and the like — switched on for one image at a time.
    if (pathname === '/api/queue/item/effect' && method === 'POST') {
      const body = await readJson(request)
      const item = queue.setEffect(String(body.id ?? ''), body.effect, Boolean(body.on))
      if (!item) {
        sendJson(response, 404, { error: 'That queue item is gone.' })
        return true
      }
      sendJson(response, 200, item)
      return true
    }

    if (pathname === '/api/queue/item/backdrop' && method === 'POST') {
      const body = await readJson(request)
      const item = queue.setBackdrop(String(body.id ?? ''), body.backdrop, body.colour)
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
  if (pathname.startsWith('/api/drive')) return handleDrive(request, response, pathname, method)
  if (pathname.startsWith('/api/cloudinary')) return handleCloudinary(request, response, pathname, method)

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
