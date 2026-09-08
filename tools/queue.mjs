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
 * The wording the launcher cannot write for itself.
 *
 * Surfaces and camera clauses live in the dashboard's prompt writer, not here,
 * so the browser hands the finished sentences over and the launcher only ever
 * slots them in. Kept at module level as well as on the queue so wording that
 * arrives before any queue does is not lost.
 */
let backdrops = []
let cameras = {}
let templates = null

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
    const notes = [
      item.surface ?? item.backdrop,
      ...(item.effects ?? []),
      item.writtenBy ? `written by ${item.writtenBy}` : item.edited ? 'edited' : '',
    ].filter(Boolean)
    lines.push(`--- ${item.angle} (${item.tag})${notes.length ? ` · ${notes.join(' · ')}` : ''} ---`, item.prompt, '')
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
    if (active.backdrops?.length) backdrops = active.backdrops
    if (active.cameras) cameras = active.cameras
    if (active.templates) templates = active.templates
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
    const before = new Map(previous.items.map((item) => [item.id, item]))
    let carried = 0
    let kept = 0
    for (const item of draft.items) {
      const was = before.get(item.id)
      if (!was) continue
      if (was.status && was.status !== 'pending') {
        item.status = was.status
        carried += 1
      }
      // A rewritten prompt is hand-made work; re-sending after a settings tweak
      // should no more discard it than it discards the done flags.
      if (was.edited || was.backdrop) {
        item.basePrompt = item.prompt
        item.prompt = was.prompt
        if (was.edited) item.edited = true
        if (was.backdrop) item.backdrop = was.backdrop
        if (was.colour) item.colour = was.colour
        if (was.surface) item.surface = was.surface
        if (was.effects?.length) item.effects = was.effects
        if (was.writtenBy) item.writtenBy = was.writtenBy
        kept += 1
      }
    }
    if (carried) console.log(`  Queue rebuilt: kept ${carried} finished item(s) from the previous queue.`)
    if (kept) console.log(`  Queue rebuilt: kept ${kept} hand-edited prompt(s).`)
  }

  active = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    directory: draft.directory,
    folder: draft.folder,
    ...draft.meta,
    comboCount: draft.comboCount,
    angles: draft.angles.map((angle) => ({ id: angle.id, label: angle.label })),
    backdrops,
    cameras,
    templates,
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

/* ---------------- per-image prompts ---------------- */

/** The slots a written prompt leaves. Mirrors src/angles.ts. */
const BACKDROP_TOKEN = '{{BACKDROP}}'
const ANGLE_TOKEN = '{{ANGLE}}'

/**
 * Receives the surfaces and camera clauses from the dashboard.
 *
 * A queue built before this existed carries none of it, so the dashboard offers
 * the wording every time it loads and the live queue picks it up — an afternoon
 * already half-worked gets the feature without being rebuilt.
 */
export function setWording({ backdrops: list, angles, templates: parts }) {
  const cleaned = (Array.isArray(list) ? list : [])
    .filter((entry) => entry?.id && entry?.block && entry?.realism)
    .map((entry) => ({
      id: String(entry.id),
      label: String(entry.label ?? entry.id),
      value: String(entry.value ?? entry.id),
      // Null for a surface that is a colour and nothing else, so there is
      // nothing underneath it to recolour.
      material: entry.material ? String(entry.material) : null,
      block: String(entry.block),
      realism: String(entry.realism),
    }))
  if (!cleaned.length) fail('That backdrop menu was empty.')
  backdrops = cleaned

  // Camera clauses, by angle id — what a rewritten prompt's {{ANGLE}} slot needs.
  cameras = Object.fromEntries(
    (Array.isArray(angles) ? angles : [])
      .filter((angle) => angle?.id && angle?.camera)
      .map((angle) => [String(angle.id), String(angle.camera)]),
  )

  // The parts a coloured surface is composed from: too many combinations to
  // send as finished sentences, so the paragraph arrives with a slot in it.
  templates = parts?.block && parts?.surfaceToken
    ? {
        surfaceToken: String(parts.surfaceToken),
        block: String(parts.block),
        realism: String(parts.realism ?? ''),
        colours: (Array.isArray(parts.colours) ? parts.colours : [])
          .filter((colour) => colour?.id)
          .map((colour) => ({ id: String(colour.id), label: String(colour.label ?? colour.id) })),
        effects: (Array.isArray(parts.effects) ? parts.effects : [])
          .filter((effect) => effect?.id && effect?.text)
          .map((effect) => ({
            id: String(effect.id),
            label: String(effect.label ?? effect.id),
            text: String(effect.text),
          })),
      }
    : templates

  if (active) {
    active.backdrops = cleaned
    active.cameras = cameras
    active.templates = templates
    save()
  }
  return {
    backdrops: cleaned.length,
    cameras: Object.keys(cameras).length,
    colours: templates?.colours.length ?? 0,
    effects: templates?.effects.length ?? 0,
  }
}

/**
 * The surface a prompt is currently describing, when it was never recorded.
 *
 * Queues built before backdrops could be changed per image only have the
 * finished prose, so the phrase is found by looking for one the menu knows.
 * Longest first, because 'a warm walnut wood surface with open visible grain'
 * and 'polished marble' can both be on the menu and only the longer match is
 * the whole phrase.
 */
function currentBackdrop(prompt, menu) {
  return menu
    .map((entry) => entry.value)
    .filter((value) => value && prompt.includes(value))
    .sort((a, b) => b.length - a.length)[0] ?? null
}

/**
 * Swaps the surface in a prompt the dashboard already wrote.
 *
 * Text surgery rather than a re-render: the launcher has no copy of the prompt
 * writer. Three shapes turn up, so all three are handled — a built-in prompt
 * keeps the surface and its lighting on their own lines; a prompt still holding
 * its slot just needs filling; and a prompt the model wrote has the surface
 * buried in prose, where the only handle is the phrase itself.
 *
 * All three are idempotent: the replacement leaves a handle of the same kind
 * behind, so changing your mind a second time works as well as the first.
 */
function applyBackdrop(prompt, option, menu, known = null) {
  let changed = false
  let swapped = prompt
    .split('\n')
    .map((line) => {
      if (line.startsWith('Set the pieces on ')) {
        changed = true
        return option.block
      }
      if (line.startsWith('Shoot it as a real photograph')) {
        changed = true
        return option.realism
      }
      return line
    })
    .join('\n')
  if (changed) return { prompt: swapped, changed }

  // A prompt the model wrote may keep the slot instead of a sentence.
  if (swapped.includes(BACKDROP_TOKEN)) {
    return { prompt: swapped.split(BACKDROP_TOKEN).join(option.value), changed: true }
  }

  const previous = known ?? currentBackdrop(swapped, menu)
  if (!previous) return { prompt: swapped, changed: false }
  // Already the surface being asked for — going back to it is a success, not a
  // prompt that could not be understood.
  if (previous === option.value) return { prompt: swapped, changed: true }

  // The written prompts phrase it as "on a <surface> background". A scene
  // surface is already a whole noun phrase — it brings its own article and
  // reading "on a a velvet surface ... background" is nonsense — while a short
  // named one is a bare noun that still wants both words around it. So the
  // article and the trailing word are matched too, and put back only when the
  // incoming surface needs them.
  const whole = /^an? /.test(option.value)
  const previousWhole = /^an? /.test(previous)
  const pattern = new RegExp(`(\\ban?\\s+)?${previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s+background)?`, 'g')
  swapped = swapped.replace(pattern, (_match, article, background) => {
    if (whole) return option.value
    return `${article ?? (previousWhole ? 'a ' : '')}${option.value}${background ?? (previousWhole ? ' background' : '')}`
  })
  return { prompt: swapped, changed: true }
}

/**
 * The prompt this item started with, remembered the first time it is touched.
 *
 * Kept so "reset" means something and so switching backdrops repeatedly does
 * not layer one rewrite on top of another.
 */
function rememberBase(item) {
  if (item.basePrompt === undefined) item.basePrompt = item.prompt
  return item.basePrompt
}

function find(itemId) {
  if (!active) return null
  return active.items.find((entry) => entry.id === itemId) ?? null
}

/** Replaces one item's prompt by hand; an empty one puts the original back. */
export function setPrompt(itemId, prompt) {
  const item = find(itemId)
  if (!item) return null
  const text = String(prompt ?? '').trim()
  const base = rememberBase(item)
  if (!text) {
    item.prompt = base
    delete item.edited
    delete item.backdrop
    delete item.colour
    delete item.surface
    delete item.effects
    delete item.writtenBy
  } else {
    item.prompt = text
    item.edited = text !== base
    if (!item.edited) delete item.edited
    // The typed text is the truth: an effect paragraph deleted by hand is off.
    const present = effectMenu().filter((effect) => text.includes(effect.text)).map((effect) => effect.id)
    if (present.length) item.effects = present
    else delete item.effects
  }
  save()
  writePromptSheet(active)
  return item
}

/* ---------------- atmosphere ---------------- */

function effectMenu() {
  return (active?.templates ?? templates)?.effects ?? []
}

/**
 * The prompt with every effect paragraph removed.
 *
 * Removing rather than remembering an offset means a prompt that has since been
 * rewritten — by hand or by a model — still comes clean.
 */
function withoutEffects(prompt) {
  let stripped = prompt
  for (const effect of effectMenu()) {
    stripped = stripped.split(`\n\n${effect.text}`).join('').split(effect.text).join('')
  }
  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** The prompt with exactly the effects this item has switched on, at the end. */
function withEffects(prompt, item) {
  const on = new Set(item.effects ?? [])
  const wanted = effectMenu().filter((effect) => on.has(effect.id))
  const clean = withoutEffects(prompt)
  return wanted.length ? `${clean}\n\n${wanted.map((effect) => effect.text).join('\n\n')}` : clean
}

/** Switches one atmospheric effect on or off for a single image. */
export function setEffect(itemId, effectId, on) {
  const item = find(itemId)
  if (!item) return null
  const effect = effectMenu().find((entry) => entry.id === String(effectId ?? ''))
  if (!effect) fail('That effect is not on the menu — reload Combo Maker and try again.')

  const enabled = new Set(item.effects ?? [])
  if (on) enabled.add(effect.id)
  else enabled.delete(effect.id)
  item.effects = [...enabled]
  if (!item.effects.length) delete item.effects

  rememberBase(item)
  item.prompt = withEffects(item.prompt, item)
  save()
  writePromptSheet(active)
  return item
}

/**
 * A surface in a colour that was not one of the ready-made ones.
 *
 * The colour goes where the surface's own colour used to be — after the article
 * when it has one, so "a velvet surface with soft directional pile" becomes
 * "a deep emerald green velvet surface with soft directional pile" rather than
 * something that reads like a list.
 */
function recolour(option, colour) {
  const parts = active?.templates ?? templates
  if (!colour || !option.material || !parts) return option
  const material = option.material
  // The article is rebuilt rather than kept: "an antique mirror" in dove grey
  // is "a soft dove grey antique mirror", and the old "an" would be wrong.
  const article = /^[aeiou]/i.test(colour.id) ? 'an ' : 'a '
  const value = /^an?\s/.test(material)
    ? material.replace(/^an?\s+/, `${article}${colour.id} `)
    : `${colour.id} ${material}`
  return {
    ...option,
    value,
    block: parts.block.split(parts.surfaceToken).join(value),
    realism: parts.realism || option.realism,
  }
}

/**
 * Puts one item on a different surface, optionally in a colour of its own.
 *
 * A hand-edited prompt is swapped in place so the edit survives; an untouched
 * one is rebuilt from the original, so the surface can be changed as many times
 * as you like without the prompt drifting.
 */
export function setBackdrop(itemId, backdropId, colourId) {
  const item = find(itemId)
  if (!item) return null
  const menu = active.backdrops?.length ? active.backdrops : backdrops
  const chosen = menu.find((entry) => entry.id === String(backdropId ?? ''))
  if (!chosen) fail('That backdrop is not on the menu — reload Combo Maker and try again.')

  const parts = active.templates ?? templates
  const colour = colourId ? parts?.colours.find((entry) => entry.id === String(colourId)) : null
  if (colourId && !colour) fail('That colour is not on the menu — reload Combo Maker and try again.')
  if (colour && !chosen.material) fail(`${chosen.label} has no material to tint — pick a surface first.`)

  const option = recolour(chosen, colour)
  const base = rememberBase(item)
  // A coloured surface is not on the menu, so the phrase it replaced has to be
  // remembered rather than looked up.
  const source = withoutEffects(item.edited ? item.prompt : base)
  const previous = item.edited && item.surface && source.includes(item.surface) ? item.surface : null
  const { prompt, changed } = applyBackdrop(source, option, menu, previous)
  if (!changed) {
    fail('Could not find the surface in this prompt — rewrite it by hand instead.')
  }
  // The surface is swapped on the prompt without its atmosphere, then the
  // atmosphere goes back on — otherwise changing the surface would quietly
  // switch the haze off, or leave two copies of it.
  item.prompt = withEffects(prompt, item)
  item.backdrop = chosen.id
  item.surface = option.value
  if (colour) item.colour = colour.id
  else delete item.colour
  save()
  writePromptSheet(active)
  return item
}

/** The files a model would have to look at to write this item's prompt. */
export function referencesFor(itemId) {
  const item = find(itemId)
  if (!item) return null
  return (item.references ?? []).map((relative) => referencePath(relative)).filter(Boolean)
}

/**
 * Installs a prompt a model wrote from this item's own reference pictures.
 *
 * What comes back is a template with slots rather than a finished prompt — the
 * model is shown the products, not told the camera angle or the surface, so
 * those are filled in here from what this particular item already is. That is
 * what keeps a rewrite a rewrite of *this shot* and not of the whole combo.
 */
export function setWrittenPrompt(itemId, written, model) {
  const item = find(itemId)
  if (!item) return null
  const text = String(written ?? '').trim()
  if (!text) fail('The model returned nothing to use.')

  const base = rememberBase(item)
  const menu = active.backdrops?.length ? active.backdrops : backdrops

  // The camera clause for this shot. The angle id is the second half of the
  // item id, which is how a queue built before any of this still resolves.
  const angleId = String(item.id).split('::')[1] ?? ''
  const camera = (active.cameras ?? cameras)[angleId]
  let prompt = text.split(ANGLE_TOKEN).join(camera || item.angle)

  // The surface it is already on, so a rewrite does not silently move it.
  if (prompt.includes(BACKDROP_TOKEN)) {
    const value = item.backdrop ?? currentBackdrop(base, menu) ?? 'clean seamless white'
    const option = menu.find((entry) => entry.id === value)
    const phrase = item.surface ?? option?.value ?? value
    prompt = prompt.split(BACKDROP_TOKEN).join(phrase)
    item.backdrop = option?.id ?? value
    item.surface = phrase
  }

  item.prompt = withEffects(prompt, item)
  item.edited = true
  item.writtenBy = String(model ?? '')
  save()
  writePromptSheet(active)
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
