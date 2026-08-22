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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function createQueue(root, options) {
  const images = Array.isArray(options.images) ? options.images : []
  const combos = Array.isArray(options.combos) ? options.combos : []
  const angles = Array.isArray(options.angles) ? options.angles : []
  if (!images.length) fail('No reference images were sent.')
  if (!combos.length) fail('No combos to queue.')
  if (!angles.length) fail('Pick at least one camera angle.')

  const directory = join(resolveRoot(root, options.outputRoot), safeSegment(options.folderName, 'AI combos'))
  const referenceDirectory = join(directory, '_references')
  try {
    mkdirSync(referenceDirectory, { recursive: true })
  } catch (error) {
    fail(`Could not create ${referenceDirectory}: ${error.message}`)
  }

  // Combo folder names have to be unique for the same reason the run does it:
  // two combos writing one reference file would silently lose one.
  const usedFolders = new Set()
  const safeCombos = combos.map((combo, index) => {
    const base = safeSegment(combo.folder, `combo-${index + 1}`)
    let name = base
    let counter = 2
    while (usedFolders.has(name.toLowerCase())) name = `${base}-${counter++}`
    usedFolders.add(name.toLowerCase())
    return { ...combo, folder: name }
  })

  // Every reference lands on disk under a name that says what it is, so the
  // folder is usable on its own even with the extension closed.
  const usedFiles = new Set()
  const pathById = new Map()
  safeCombos.forEach((combo, comboIndex) => {
    for (const [slot, id] of (combo.imageIds ?? []).entries()) {
      if (pathById.has(String(id))) continue
      const image = images.find((entry) => String(entry.id) === String(id))
      if (!image) continue
      const extension = EXTENSION_BY_TYPE[image.type] ?? 'jpg'
      // One composite per combo in single-reference mode; otherwise the product
      // photo, which several combos will share.
      const label = options.single
        ? combo.folder
        : safeSegment(combo.sourceNames?.[slot]?.replace(/\.[a-z0-9]+$/i, ''), `product-${comboIndex + 1}-${slot + 1}`)
      let name = `${label}.${extension}`
      let counter = 2
      while (usedFiles.has(name.toLowerCase())) name = `${label}-${counter++}.${extension}`
      usedFiles.add(name.toLowerCase())

      writeFileSync(join(referenceDirectory, name), Buffer.from(String(image.data ?? ''), 'base64'))
      pathById.set(String(id), `_references/${name}`)
    }
  })

  const items = safeCombos.flatMap((combo) =>
    angles.map((angle) => ({
      id: `${combo.folder}::${angle.id}`,
      combo: combo.folder,
      angle: String(angle.label ?? angle.id),
      tag: safeSegment(angle.tag, 'angle'),
      // A described run has a prompt per combo; otherwise the angle's own.
      prompt: String(options.comboPrompts?.[combo.folder]?.[angle.id] ?? angle.prompt ?? ''),
      references: (combo.imageIds ?? []).map((id) => pathById.get(String(id))).filter(Boolean),
      // Where the finished image should be saved, so the panel can tell you.
      saveAs: `${combo.folder}/${combo.folder} - ${safeSegment(angle.tag, 'angle')}`,
      status: 'pending',
    })),
  )

  active = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    directory,
    folder: safeSegment(options.folderName, 'AI combos'),
    subject: String(options.subject ?? ''),
    comboSize: Number(options.comboSize) || 0,
    comboCount: safeCombos.length,
    model: String(options.model ?? ''),
    aspectRatio: String(options.aspectRatio ?? ''),
    resolution: options.resolution ? String(options.resolution) : null,
    angles: angles.map((angle) => ({ id: String(angle.id), label: String(angle.label ?? angle.id) })),
    items,
  }

  save()
  writePromptSheet(active)
  writeFileSync(join(root, POINTER_FILE), directory, 'utf8')
  return active
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
