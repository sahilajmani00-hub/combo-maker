/**
 * The hand-off between the dashboard and the browser extension.
 *
 * The dashboard knows which products go in which combo and what to say about
 * each angle; the person doing the uploading is over on higgsfield.ai with none
 * of that in front of them. A queue is that work written down: one entry per
 * combo per angle, each with its reference image already composited and its
 * prompt already written, so the job becomes "copy, paste, upload, next"
 * instead of "which of these 480 prompts went with which picture".
 *
 * It lives on disk rather than in memory so closing the launcher - or the
 * browser - does not lose where you were.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Remembers which queue folder is the live one across launcher restarts. */
const POINTER_FILE = '.active-queue'

const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g

const EXTENSION_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

let active = null

/**
 * A queue being assembled batch by batch.
 *
 * Composited references are the bulk of a queue's bytes — a few hundred
 * kilobytes each — so a large run cannot arrive as one request without holding
 * the whole thing in memory twice. The browser sends it in pieces instead, and
 * each piece is written to disk as it lands.
 */
let draft = null

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

function fail(message) {
  const error = new Error(message)
  error.expected = true
  throw error
}

function resolveRoot(root, requested) {
  const value = String(requested ?? '').trim()
  if (!value) return join(root, 'ai-combos')
  return isAbsolute(value) ? resolve(value) : resolve(root, value)
}

/* ---------------- persistence ---------------- */

function queueFile(directory) {
  return join(directory, 'queue.json')
}

function save() {
  if (!active) return
  writeFileSync(queueFile(active.directory), `${JSON.stringify(active, null, 2)}\n`, 'utf8')
}

/** A plain-text copy, for anyone who would rather work from a document. */
function writePromptSheet(queue) {
  const lines = [
    `${queue.folder}`,
    `${queue.items.length} images — ${queue.comboCount} combos x ${queue.angles.length} angles`,
    `Model ${queue.model} · ${queue.aspectRatio}${queue.resolution ? ` · ${queue.resolution}` : ''}`,
    '',
  ]
  let current = null
  for (const item of queue.items) {
    if (item.combo !== current) {
      current = item.combo
      lines.push('', `## ${item.combo}`, `reference: ${item.references.join(', ')}`, '')
    }
    lines.push(`--- ${item.angle} (${item.tag}) ---`, item.prompt, '')
  }
  writeFileSync(join(queue.directory, 'prompts.txt'), `${lines.join('\n')}\n`, 'utf8')
}

/** Reloads the queue a previous launcher session wrote, if it is still there. */
export function restore(root) {
  try {
    const pointer = join(root, POINTER_FILE)
    if (!existsSync(pointer)) return null
    const directory = readFileSync(pointer, 'utf8').trim()
    if (!directory || !existsSync(queueFile(directory))) return null
    active = JSON.parse(readFileSync(queueFile(directory), 'utf8'))
    return active
  } catch {
    return null
  }
}

/* ---------------- building ---------------- */

/** Opens a queue and prepares its folder; combos arrive afterwards. */
export function beginQueue(root, options) {
  const angles = Array.isArray(options.angles) ? options.angles : []
  if (!angles.length) fail('Pick at least one camera angle.')

  const folder = safeSegment(options.folderName, 'AI combos')
  const directory = join(resolveRoot(root, options.outputRoot), folder)
  try {
    mkdirSync(join(directory, '_references'), { recursive: true })
  } catch (error) {
    fail(`Could not create ${directory}: ${error.message}`)
  }

  draft = {
    root,
    directory,
    folder,
    single: Boolean(options.single),
    meta: {
      subject: String(options.subject ?? ''),
      comboSize: Number(options.comboSize) || 0,
      model: String(options.model ?? ''),
      aspectRatio: String(options.aspectRatio ?? ''),
      resolution: options.resolution ? String(options.resolution) : null,
    },
    angles: angles.map((angle, index) => ({
      id: String(angle.id ?? `angle-${index + 1}`),
      label: String(angle.label ?? angle.id ?? `Angle ${index + 1}`),
      tag: safeSegment(angle.tag, `angle-${index + 1}`),
      prompt: String(angle.prompt ?? ''),
    })),
    items: [],
    comboCount: 0,
    usedFolders: new Set(),
    usedFiles: new Set(),
    // Spans batches: in multi-reference mode the product photos arrive with the
    // first batch and are reused by every combo after it.
    pathById: new Map(),
  }
  return { folder, directory }
}

/** Adds one batch of combos, writing their references straight to disk. */
export function appendQueue(batch) {
  if (!draft) fail('No queue is being built — start one first.')
  const images = Array.isArray(batch.images) ? batch.images : []
  const combos = Array.isArray(batch.combos) ? batch.combos : []

  const { pathById } = draft
  for (const combo of combos) {
    const name = (() => {
      const base = safeSegment(combo.folder, `combo-${draft.comboCount + 1}`)
      let candidate = base
      let counter = 2
      while (draft.usedFolders.has(candidate.toLowerCase())) candidate = `${base}-${counter++}`
      draft.usedFolders.add(candidate.toLowerCase())
      return candidate
    })()
    draft.comboCount += 1

    const references = []
    for (const [slot, id] of (combo.imageIds ?? []).entries()) {
      let reference = pathById.get(String(id))
      if (!reference) {
        const image = images.find((entry) => String(entry.id) === String(id))
        if (!image) continue
        const extension = EXTENSION_BY_TYPE[image.type] ?? 'jpg'
        const label = draft.single
          ? name
          : safeSegment(combo.sourceNames?.[slot]?.replace(/\.[a-z0-9]+$/i, ''), `product-${slot + 1}`)
        let file = `${label}.${extension}`
        let counter = 2
        while (draft.usedFiles.has(file.toLowerCase())) file = `${label}-${counter++}.${extension}`
        draft.usedFiles.add(file.toLowerCase())
        writeFileSync(join(draft.directory, '_references', file), Buffer.from(String(image.data ?? ''), 'base64'))
        reference = `_references/${file}`
        pathById.set(String(id), reference)
      }
      references.push(reference)
    }

    for (const angle of draft.angles) {
      draft.items.push({
        id: `${name}::${angle.id}`,
        combo: name,
        angle: angle.label,
        tag: angle.tag,
        prompt: String(combo.prompts?.[angle.id] ?? angle.prompt ?? ''),
        references,
        saveAs: `${name}/${name} - ${angle.tag}`,
        status: 'pending',
        sources: combo.sourceNames ?? [],
      })
    }
  }
  return { combos: draft.comboCount, items: draft.items.length }
}

/** Seals the queue: carries over finished items, writes it, makes it live. */
export function finishQueue() {
  if (!draft) fail('No queue is being built — start one first.')
  if (!draft.items.length) fail('No combos were sent.')

  // Rebuilding into a folder that already has a queue must not silently throw
  // away what has been finished — re-sending after a prompt tweak is normal.
  const previous = existsSync(queueFile(draft.directory))
    ? (() => {
        try {
          return JSON.parse(readFileSync(queueFile(draft.directory), 'utf8'))
        } catch {
          return null
        }
      })()
    : null
  if (previous) {
    const before = new Map(previous.items.map((item) => [item.id, item.status]))
    let carried = 0
    for (const item of draft.items) {
      const status = before.get(item.id)
      if (status && status !== 'pending') {
        item.status = status
        carried += 1
      }
    }
    if (carried) console.log(`  Queue rebuilt: kept ${carried} finished item(s) from the previous queue.`)
  }

  active = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    directory: draft.directory,
    folder: draft.folder,
    ...draft.meta,
    comboCount: draft.comboCount,
    angles: draft.angles.map((angle) => ({ id: angle.id, label: angle.label })),
    items: draft.items,
  }
  const root = draft.root
  draft = null

  save()
  writePromptSheet(active)
  writeFileSync(join(root, POINTER_FILE), active.directory, 'utf8')
  return active
}

/** One-shot build, for small queues and for tests. */
export function createQueue(root, options) {
  const images = Array.isArray(options.images) ? options.images : []
  const combos = Array.isArray(options.combos) ? options.combos : []
  if (!images.length) fail('No reference images were sent.')
  if (!combos.length) fail('No combos to queue.')
  beginQueue(root, options)
  appendQueue({
    images,
    combos: combos.map((combo) => ({ ...combo, prompts: options.comboPrompts?.[combo.folder] })),
  })
  return finishQueue()
}

/* ---------------- reading and updating ---------------- */

export function getQueue() {
  return active
}

export function setStatus(itemId, status) {
  if (!active) return null
  const item = active.items.find((entry) => entry.id === itemId)
  if (!item) return null
  item.status = ['pending', 'done', 'skipped'].includes(status) ? status : 'pending'
  save()
  return item
}

/**
 * Forgets the queue entirely, so the panel goes back to empty.
 *
 * The folder stays on disk untouched — the references and prompts.txt are work
 * product, and "clear the list" should never be a way to lose them by accident.
 * Pointing a queue at that folder again picks it straight back up.
 */
export function clearQueue(root) {
  const had = Boolean(active)
  active = null
  try {
    rmSync(join(root, POINTER_FILE), { force: true })
  } catch {
    /* the pointer is a convenience; failing to remove it is not fatal */
  }
  return had
}

/** Puts every item back to pending, for a second pass over the same queue. */
export function resetStatuses() {
  if (!active) return null
  for (const item of active.items) item.status = 'pending'
  save()
  return active
}

/**
 * Resolves a reference path inside the queue folder.
 *
 * The extension asks for these by relative path, so the traversal check is what
 * keeps `../../` from turning the launcher into a file server for the disk.
 */
export function referencePath(relative) {
  if (!active) return null
  const target = normalize(join(active.directory, String(relative ?? '')))
  if (target !== active.directory && !target.startsWith(active.directory + sep)) return null
  return existsSync(target) ? target : null
}
