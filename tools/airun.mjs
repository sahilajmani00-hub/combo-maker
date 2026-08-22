/**
 * Runs a batch of Higgsfield generations and files the results on disk.
 *
 * One run means: every combo the browser asked for, shot from every angle it
 * picked. That is combos x angles generations, which for ten photos in threes
 * across four angles is 480 images - so the run is asynchronous, resumable and
 * cancellable, and progress is polled rather than held open on one request.
 *
 * On disk it comes out as:
 *
 *   <output root>/<master folder>/
 *     manifest.json
 *     earring1&earring2&earring3/
 *       earring1&earring2&earring3 - front.jpg
 *       earring1&earring2&earring3 - 34-left.jpg
 *     earring1&earring2&earring4/
 *       ...
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as higgsfield from './higgsfield.mjs'

/** Ceiling on one run. Every job costs credits, so this is a wallet guard. */
export const MAX_JOBS = 600

/** How many generations are in flight at once. */
const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 8

/** Uploads are cheap and independent, so they can run wider than generations. */
const UPLOAD_CONCURRENCY = 4

/** Finished runs stay readable for a while so a reloaded tab can still see them. */
const RUN_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The image models a combo can be shot with.
 *
 * They split by how many reference images they take, which decides how the
 * browser prepares a combo:
 *
 * - `many` - the products go up as separate references and the model puts them
 *   in one frame itself.
 * - `one`  - the model takes a single reference, so the browser composites the
 *   combo on canvas first and sends that. Soul is the only image model every
 *   account carries, so this path is the one that always works.
 *
 * Aspect ratios differ per model and the API rejects one it does not list, so
 * each carries its own set rather than sharing a global list.
 */
export const MODELS = {
  'soul-reference': {
    label: 'Higgsfield Soul',
    note: 'On every account. The combo is composited locally, then re-shot from each angle.',
    references: 'one',
    maxImages: 1,
    endpoint: 'higgsfield-ai/soul/reference',
    aspectRatios: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'],
    // 1080p costs exactly twice 720p, which is worth a control of its own.
    resolutions: ['1080p', '720p'],
    body: ({ prompt, imageUrls, aspectRatio, resolution }) => ({
      prompt,
      image_reference_url: imageUrls[0],
      aspect_ratio: aspectRatio,
      resolution,
      // The prompt is written to hold the products still; letting the service
      // rewrite it is exactly how an extra earring gets invented.
      enhance_prompt: false,
    }),
  },
  'nano-banana': {
    label: 'Nano Banana',
    note: 'Sends each product separately. Best fidelity, but not on every account.',
    references: 'many',
    maxImages: 8,
    endpoint: 'nano-banana',
    aspectRatios: ['1:1', '4:5', '3:4', '4:3', '3:2', '2:3', '16:9', '9:16'],
    body: ({ prompt, imageUrls, aspectRatio, format }) => ({
      prompt,
      aspect_ratio: aspectRatio,
      output_format: format,
      input_images: imageUrls.map((url) => ({ type: 'image_url', image_url: url })),
    }),
  },
  'reve-remix': {
    label: 'Reve Remix',
    note: 'A different look. Needs 2 to 4 products per combo.',
    references: 'many',
    minImages: 2,
    maxImages: 4,
    endpoint: 'reve/remix',
    aspectRatios: ['1:1', '4:5', '3:4', '4:3', '3:2', '2:3', '16:9', '9:16'],
    body: ({ prompt, imageUrls, aspectRatio }) => ({
      prompt,
      aspect_ratio: aspectRatio,
      image_urls: imageUrls,
    }),
  },
  'reve-remix-fast': {
    label: 'Reve Remix (fast)',
    note: 'Quicker and cheaper than Reve Remix. Needs 2 to 4 products.',
    references: 'many',
    minImages: 2,
    maxImages: 4,
    endpoint: 'reve/fast/remix',
    aspectRatios: ['1:1', '4:5', '3:4', '4:3', '3:2', '2:3', '16:9', '9:16'],
    body: ({ prompt, imageUrls, aspectRatio }) => ({
      prompt,
      aspect_ratio: aspectRatio,
      image_urls: imageUrls,
    }),
  },
}

const EXTENSION_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Characters Windows and macOS refuse, plus the path separators. */
const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g

const runs = new Map()

/**
 * Makes one path segment safe.
 *
 * The browser already builds these names, but they arrive over HTTP, so a
 * segment that climbed out of the output folder with "../" would be a real
 * problem - everything gets flattened here rather than trusted.
 */
function safeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(ILLEGAL_SEGMENT, '')
    .split('')
    .filter((char) => char >= ' ')
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 150)
    .replace(/[.\s]+$/, '')
  return cleaned || fallback
}

/** Models without a resolution choice ignore it; the rest get a valid one. */
export function resolutionFor(model, requested) {
  if (!model.resolutions) return null
  return model.resolutions.includes(String(requested)) ? String(requested) : model.resolutions[0]
}

/**
 * A request body shaped like a real one, for the estimate endpoint.
 *
 * The placeholder URL is never fetched — estimation prices the parameters, not
 * the picture.
 */
export function estimateBody(model, { aspectRatio, resolution, format = 'jpeg' }) {
  const count = Math.max(model.minImages ?? 1, 1)
  return model.body({
    prompt: 'estimate',
    imageUrls: Array.from({ length: count }, () => 'https://example.com/reference.jpg'),
    aspectRatio: model.aspectRatios.includes(String(aspectRatio)) ? String(aspectRatio) : model.aspectRatios[0],
    resolution: resolutionFor(model, resolution),
    format,
  })
}

function fail(message) {
  const error = new Error(message)
  error.expected = true
  throw error
}

/** Runs `tasks` with at most `size` in flight. */
async function pool(size, tasks) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(size, tasks.length)) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++]
      await task()
    }
  })
  await Promise.all(workers)
}

/** Where a run writes, defaulting to ai-combos/ beside the app. */
export function defaultOutputRoot(root) {
  return join(root, 'ai-combos')
}

function resolveOutputRoot(root, requested) {
  const value = String(requested ?? '').trim()
  if (!value) return defaultOutputRoot(root)
  // A relative path is relative to the app folder, which is what someone
  // typing "combos" into the field almost certainly means.
  return isAbsolute(value) ? resolve(value) : resolve(root, value)
}

/* ---------------- manifest ---------------- */

function manifestFor(run) {
  return {
    run: run.id,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    status: run.status,
    model: run.model,
    comboSize: run.comboSize,
    aspectRatio: run.aspectRatio,
    resolution: run.resolution,
    folder: run.folder,
    totals: { total: run.items.length, done: run.done, failed: run.failed, skipped: run.skipped },
    angles: run.angles.map((angle) => ({ id: angle.id, label: angle.label, tag: angle.tag, prompt: angle.prompt })),
    combos: run.combos.map((combo) => ({
      folder: combo.folder,
      sources: combo.sourceNames,
      prompts: combo.prompts,
      images: run.items
        .filter((item) => item.combo === combo.folder)
        .map((item) => ({
          angle: item.angle,
          file: item.file,
          status: item.status,
          error: item.error,
          requestId: item.requestId,
        })),
    })),
  }
}

/**
 * Written after every finished image, not just at the end - a run this long
 * should leave a usable record even if the window is closed halfway through.
 */
function saveManifest(run) {
  try {
    writeFileSync(join(run.directory, 'manifest.json'), `${JSON.stringify(manifestFor(run), null, 2)}\n`, 'utf8')
  } catch (error) {
    run.warning = `Could not write manifest.json: ${error.message}`
  }
}

/* ---------------- run lifecycle ---------------- */

export function createRun(root, credentials, options) {
  const modelId = options.model in MODELS ? options.model : 'soul-reference'
  const model = MODELS[modelId]
  const images = Array.isArray(options.images) ? options.images : []
  const combos = Array.isArray(options.combos) ? options.combos : []
  const angles = Array.isArray(options.angles) ? options.angles : []

  if (!images.length) fail('No product images were sent.')
  if (!combos.length) fail('No combos to build.')
  if (!angles.length) fail('Pick at least one camera angle.')

  const comboSize = combos[0].imageIds.length
  if (comboSize < (model.minImages ?? 1)) {
    fail(`${model.label} needs at least ${model.minImages} products in a combo.`)
  }
  if (comboSize > model.maxImages) {
    fail(`${model.label} accepts at most ${model.maxImages} products in a combo.`)
  }

  const total = combos.length * angles.length
  if (total > MAX_JOBS) {
    fail(`That is ${total} generations. Reduce the combos or angles to stay under ${MAX_JOBS} per run.`)
  }

  const outputRoot = resolveOutputRoot(root, options.outputRoot)
  const folder = safeSegment(options.folderName, 'AI combos')
  const directory = join(outputRoot, folder)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    fail(`Could not create ${directory}: ${error.message}`)
  }

  // Folder names must stay unique inside the run, exactly as the browser's
  // combo filenames do, or two combos would write into one folder.
  const usedFolders = new Set()
  const safeCombos = combos.map((combo, index) => {
    const base = safeSegment(combo.folder, `combo-${index + 1}`)
    let name = base
    let counter = 2
    while (usedFolders.has(name.toLowerCase())) name = `${base}-${counter++}`
    usedFolders.add(name.toLowerCase())
    return {
      folder: name,
      imageIds: combo.imageIds ?? [],
      sourceNames: combo.sourceNames ?? [],
      // Set when the products have been described: the prompt then names the
      // actual products, so it differs per combo rather than only per angle.
      prompts: combo.prompts && typeof combo.prompts === 'object' ? combo.prompts : null,
    }
  })

  const safeAngles = angles.map((angle, index) => ({
    id: String(angle.id ?? `angle-${index + 1}`),
    label: String(angle.label ?? angle.id ?? `Angle ${index + 1}`),
    tag: safeSegment(angle.tag, `angle-${index + 1}`),
    prompt: String(angle.prompt ?? ''),
  }))

  const run = {
    id: randomUUID(),
    status: 'preparing',
    startedAt: Date.now(),
    finishedAt: null,
    directory,
    folder,
    model: modelId,
    comboSize,
    aspectRatio: model.aspectRatios.includes(String(options.aspectRatio))
      ? String(options.aspectRatio)
      : model.aspectRatios[0],
    resolution: resolutionFor(model, options.resolution),
    format: options.format === 'png' ? 'png' : 'jpeg',
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY)),
    combos: safeCombos,
    angles: safeAngles,
    done: 0,
    failed: 0,
    skipped: 0,
    error: null,
    warning: null,
    controller: new AbortController(),
    items: safeCombos.flatMap((combo) =>
      safeAngles.map((angle) => ({
        combo: combo.folder,
        angle: angle.label,
        angleId: angle.id,
        status: 'pending',
        file: null,
        previewUrl: null,
        requestId: null,
        error: null,
      })),
    ),
  }

  runs.set(run.id, run)
  sweep()
  // Deliberately not awaited: the caller answers with the run id straight away
  // and the browser follows progress by polling.
  execute(run, credentials, images, model).catch((error) => {
    run.status = 'failed'
    run.error = error.message
    run.finishedAt = Date.now()
  })
  return run
}

async function execute(run, credentials, images, model) {
  const { signal } = run.controller

  // Every product is uploaded once and its URL reused by every combo it
  // appears in - the same photo would otherwise be uploaded dozens of times.
  const urls = new Map()
  const uploads = images.map((image) => async () => {
    if (signal.aborted) return
    const contentType = EXTENSION_BY_TYPE[image.type] ? image.type : 'image/jpeg'
    const url = await higgsfield.uploadImage(credentials, {
      data: Buffer.from(String(image.data ?? ''), 'base64'),
      contentType,
      signal,
    })
    urls.set(String(image.id), url)
  })

  try {
    await pool(UPLOAD_CONCURRENCY, uploads)
  } catch (error) {
    run.status = 'failed'
    run.error = `Uploading the product photos failed: ${error.message}`
    run.finishedAt = Date.now()
    saveManifest(run)
    return
  }

  if (signal.aborted) {
    finish(run, 'cancelled')
    return
  }

  run.status = 'running'
  let lastSave = 0
  const touch = () => {
    // Throttled so a fast run does not rewrite the manifest hundreds of times.
    if (Date.now() - lastSave < 1000) return
    lastSave = Date.now()
    saveManifest(run)
  }

  const jobs = run.items.map((item) => async () => {
    if (signal.aborted) return
    const combo = run.combos.find((entry) => entry.folder === item.combo)
    const angle = run.angles.find((entry) => entry.id === item.angleId)
    item.status = 'running'
    try {
      const imageUrls = combo.imageIds.map((id) => {
        const url = urls.get(String(id))
        if (!url) throw new Error('A product photo was missing from the upload.')
        return url
      })

      const comboDirectory = join(run.directory, combo.folder)
      mkdirSync(comboDirectory, { recursive: true })

      // Re-running into an existing master folder tops it up rather than
      // paying to generate images that are already sitting there.
      const existing = ['jpg', 'png', 'webp']
        .map((extension) => join(comboDirectory, `${combo.folder} - ${angle.tag}.${extension}`))
        .find((path) => existsSync(path))
      if (existing) {
        item.status = 'skipped'
        item.file = existing.slice(run.directory.length + 1)
        run.skipped += 1
        touch()
        return
      }

      const submitted = await higgsfield.submit(
        credentials,
        model.endpoint,
        model.body({
          prompt: combo.prompts?.[angle.id] || angle.prompt,
          imageUrls,
          aspectRatio: run.aspectRatio,
          format: run.format,
          resolution: run.resolution,
        }),
        signal,
      )
      item.requestId = submitted.request_id ?? null

      const result = submitted.status === 'completed'
        ? submitted
        : await higgsfield.waitForResult(credentials, submitted.status_url, { signal })

      if (result.status !== 'completed') {
        throw new Error(result.error || `Higgsfield returned "${result.status}".`)
      }
      const url = result.images?.[0]?.url
      if (!url) throw new Error('Higgsfield finished without returning an image.')

      const { data, contentType } = await higgsfield.fetchBinary(url, signal)
      const extension = EXTENSION_BY_TYPE[contentType] ?? (run.format === 'png' ? 'png' : 'jpg')
      const fileName = `${combo.folder} - ${angle.tag}.${extension}`
      writeFileSync(join(comboDirectory, fileName), data)

      item.status = 'done'
      item.file = join(combo.folder, fileName)
      item.previewUrl = url
      run.done += 1
    } catch (error) {
      if (signal.aborted) {
        item.status = 'pending'
        return
      }
      item.status = 'failed'
      item.error = error.message
      run.failed += 1
    }
    touch()
  })

  await pool(run.concurrency, jobs)
  finish(run, signal.aborted ? 'cancelled' : 'finished')
}

function finish(run, status) {
  run.status = status
  run.finishedAt = Date.now()
  saveManifest(run)
}

/** Drops runs nobody is watching any more so the process does not grow forever. */
function sweep() {
  for (const [id, run] of runs) {
    if (run.finishedAt && Date.now() - run.finishedAt > RUN_TTL_MS) runs.delete(id)
  }
}

export function getRun(id) {
  return runs.get(id) ?? null
}

export function cancelRun(id) {
  const run = runs.get(id)
  if (!run || run.finishedAt) return false
  run.controller.abort()
  return true
}

/** The shape the browser polls - no credentials, no abort controller. */
export function snapshot(run) {
  return {
    id: run.id,
    status: run.status,
    folder: run.folder,
    directory: run.directory,
    total: run.items.length,
    done: run.done,
    failed: run.failed,
    skipped: run.skipped,
    error: run.error,
    warning: run.warning,
    items: run.items.map((item) => ({
      combo: item.combo,
      angle: item.angle,
      status: item.status,
      file: item.file,
      previewUrl: item.previewUrl,
      error: item.error,
    })),
  }
}
