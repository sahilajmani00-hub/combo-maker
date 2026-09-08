/**
 * Side panel: shows one queue entry at a time while you work on higgsfield.ai.
 *
 * It reads the queue from the Combo Maker launcher on localhost and writes the
 * done/skipped flags back, so progress survives closing the browser. It does
 * not touch the page you are on — the uploading and the clicking are yours.
 */

/** The launcher walks upward from 4173 when the port is busy, so try a few. */
const PORTS = [4173, 4174, 4175, 4176, 4177]

const el = (id) => document.getElementById(id)

const state = {
  base: null,
  queue: null,
  index: 0,
  onlyPending: false,
  /**
   * Prompt rewrites typed but not yet saved, by item id.
   *
   * Held here rather than only in the textarea so that stepping to the next
   * image and back does not quietly throw away what was typed.
   */
  drafts: new Map(),
  /** The vision models the launcher will let read a reference picture. */
  readers: null,
  reader: null,
  recreating: false,
}

const say = (text, isError = false) => {
  el('status').textContent = text
  el('status').className = isError ? 'status error' : 'status'
}

/* ---------------- launcher ---------------- */

async function callApi(path, options) {
  const response = await fetch(`${state.base}${path}`, options)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`)
  return body
}

/**
 * Finds the launcher and loads the queue.
 *
 * A saved port is tried first so the common case is one request, not five.
 */
async function connect() {
  const saved = await chrome.storage.local.get('port')
  const ports = saved.port ? [saved.port, ...PORTS.filter((port) => port !== saved.port)] : PORTS

  for (const port of ports) {
    const base = `http://localhost:${port}`
    try {
      const response = await fetch(`${base}/api/queue`, { cache: 'no-store' })
      // A 404 still proves the launcher is there — it just has no queue yet.
      if (!response.ok && response.status !== 404) continue
      state.base = base
      chrome.storage.local.set({ port })
      state.queue = response.ok ? await response.json() : null
      await loadReaders()
      render()
      return
    } catch {
      /* try the next port */
    }
  }
  state.base = null
  render()
}

/* ---------------- queue navigation ---------------- */

/** The entries currently on screen — everything, or only what is left to do. */
function visible() {
  if (!state.queue) return []
  return state.onlyPending
    ? state.queue.items.filter((item) => item.status === 'pending')
    : state.queue.items
}

function current() {
  const items = visible()
  if (!items.length) return null
  state.index = Math.max(0, Math.min(state.index, items.length - 1))
  return items[state.index]
}

function step(delta) {
  state.index += delta
  render()
}

async function mark(status, advance = true) {
  const item = current()
  if (!item) return
  // Moving on is the last chance to keep what was typed.
  if (isDirty(item) && !(await savePrompt(true))) return
  try {
    await callApi('/api/queue/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, status }),
    })
    item.status = status
    // Filtering to pending renumbers the list under us, so staying put is what
    // actually advances; otherwise move on by hand.
    if (advance && !state.onlyPending) state.index += 1
    render()
    say({ done: 'Marked done.', skipped: 'Skipped.', pending: 'Put back — not done.' }[status])
  } catch (error) {
    say(error.message, true)
  }
}

/* ---------------- the two things you actually need ---------------- */

/**
 * The async clipboard API rejects when the panel does not have focus, and in
 * some states never settles at all — so it gets a deadline, and a fallback that
 * works without the permission.
 */
const withDeadline = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

async function writeText(text) {
  try {
    await withDeadline(navigator.clipboard.writeText(text), 1500)
    return true
  } catch {
    /* fall through to the legacy path */
  }
  const holder = document.createElement('textarea')
  holder.value = text
  holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(holder)
  holder.select()
  const copied = document.execCommand('copy')
  holder.remove()
  return copied
}

/* ---------------- rewriting one prompt ---------------- */

/** What is on screen for this item: the draft if there is one, else the queue's. */
function promptOf(item) {
  return state.drafts.has(item.id) ? state.drafts.get(item.id) : item.prompt
}

const isDirty = (item) => state.drafts.has(item.id) && state.drafts.get(item.id) !== item.prompt

/** Writes the draft back to the launcher, so disk and screen agree. */
async function savePrompt(silent = false) {
  const item = current()
  if (!item || !isDirty(item)) return true
  try {
    const saved = await callApi('/api/queue/item/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, prompt: state.drafts.get(item.id) }),
    })
    Object.assign(item, saved)
    state.drafts.delete(item.id)
    render()
    if (!silent) say('Prompt saved for this image.')
    return true
  } catch (error) {
    say(error.message, true)
    return false
  }
}

/** Throws the rewrite away and puts the queued prompt back. */
async function revertPrompt() {
  const item = current()
  if (!item) return
  if ((item.edited || isDirty(item)) && !confirm('Put the original prompt back? Your rewrite is lost.')) return
  state.drafts.delete(item.id)
  // Nothing was ever saved, so there is nothing for the launcher to undo.
  if (!item.edited && !item.backdrop) {
    render()
    say('Back to the queued prompt.')
    return
  }
  try {
    Object.assign(item, await callApi('/api/queue/item/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, prompt: '' }),
    }))
    render()
    say('Back to the original prompt.')
  } catch (error) {
    say(error.message, true)
  }
}

/** Switches one atmospheric effect on or off for this image alone. */
async function toggleEffect(effect, on) {
  const item = current()
  if (!item) return
  if (isDirty(item) && !(await savePrompt(true))) return
  try {
    Object.assign(item, await callApi('/api/queue/item/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, effect, on }),
    }))
    state.drafts.delete(item.id)
    render()
    const label = state.queue.templates?.effects.find((entry) => entry.id === effect)?.label ?? effect
    say(on ? `${label} added to this image.` : `${label} removed.`)
  } catch (error) {
    say(error.message, true)
    render()
  }
}

/** Puts this one image on a different surface, prompt rewritten to match. */
async function chooseBackdrop(backdrop, colour) {
  const item = current()
  if (!item || !backdrop) return
  // An unsaved rewrite is what the swap should be applied to, so it goes first.
  if (isDirty(item) && !(await savePrompt(true))) return
  try {
    Object.assign(item, await callApi('/api/queue/item/backdrop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, backdrop, colour: colour || null }),
    }))
    state.drafts.delete(item.id)
    render()
    say(`This image is now on ${item.surface}.`)
  } catch (error) {
    say(error.message, true)
    render()
  }
}

/**
 * The vision models on offer, and which one was picked last time.
 *
 * A missing key is not an error here — the launcher says so, the row explains
 * itself, and everything else in the panel carries on working.
 */
async function loadReaders() {
  try {
    const body = await callApi('/api/queue/models')
    state.readers = body
    const saved = await chrome.storage.local.get('reader')
    state.reader = body.models.some((entry) => entry.id === saved.reader)
      ? saved.reader
      : body.defaultModel
  } catch {
    state.readers = null
  }
}

/**
 * Has the chosen model look at this item's reference and write the prompt.
 *
 * The camera angle and the surface are not the model's to choose — it is shown
 * the products and nothing else, and the launcher slots this shot's own angle
 * and backdrop into what comes back.
 */
async function recreatePrompt() {
  const item = current()
  if (!item || !state.readers?.ready || state.recreating) return
  if (item.edited && !confirm('Have the model write this prompt again? What is there now is replaced.')) return

  state.recreating = true
  state.drafts.delete(item.id)
  render()
  say('Reading the reference picture...')
  try {
    Object.assign(item, await callApi('/api/queue/item/recreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, model: state.reader }),
    }))
    say(`Prompt rewritten by ${readerLabel(item.writtenBy)}. Revert puts the original back.`)
  } catch (error) {
    say(error.message, true)
  } finally {
    state.recreating = false
    render()
  }
}

const readerLabel = (id) => state.readers?.models.find((entry) => entry.id === id)?.label ?? id

async function copyPrompt() {
  const item = current()
  if (!item) return
  // Copying a rewrite is as good as committing to it — otherwise the image you
  // generate and the prompt on disk stop matching.
  const text = promptOf(item)
  if (isDirty(item)) await savePrompt(true)
  if (await writeText(text)) {
    say('Prompt copied — paste it into Higgsfield.')
    return
  }
  // Nothing worked, so at least put it where it can be copied by hand.
  el('prompt').select()
  say('Could not reach the clipboard — the prompt is selected, press Cmd/Ctrl+C.', true)
}

function referenceUrl(relative) {
  return `${state.base}/api/queue/file?path=${encodeURIComponent(relative)}`
}

/**
 * Puts the reference on the clipboard so it can be pasted straight into an
 * upload field. Clipboard image writes are PNG-only in Chrome, so the JPEG
 * gets re-encoded through a canvas first.
 */
async function copyImage() {
  const item = current()
  if (!item?.references?.length) return
  try {
    const blob = await (await fetch(referenceUrl(item.references[0]))).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    await withDeadline(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]), 3000)
    say('Reference copied — paste it into the upload box.')
  } catch (error) {
    // There is no legacy fallback for images, so point at the button that works.
    say(`Could not copy the image (${error.message}). Use Save image instead.`, true)
  }
}

/** Saves the reference next to wherever the browser puts downloads. */
function saveImage() {
  const item = current()
  if (!item?.references?.length) return
  for (const reference of item.references) {
    chrome.downloads.download({
      url: referenceUrl(reference),
      filename: `combo-maker/${reference.split('/').pop()}`,
    })
  }
  say('Reference saved to your downloads.')
}

/* ---------------- rendering ---------------- */

/**
 * The prompt box and everything that edits it.
 *
 * The backdrop menu comes from the queue rather than from here: the sentences
 * it swaps in are written by Combo Maker's prompt writer, so the panel only
 * ever offers what it was given. A queue built before the menu existed has
 * none, and the row stays hidden with the reason said out loud.
 */
function renderPrompt(item) {
  const dirty = isDirty(item)
  const box = el('prompt')
  // Retyping the value under the cursor would move it, so only write when the
  // box is actually showing something else.
  const text = promptOf(item)
  if (box.value !== text) box.value = text
  box.classList.toggle('dirty', dirty)

  el('save-prompt').disabled = !dirty
  el('save-prompt').textContent = dirty ? 'Save prompt *' : 'Save prompt'
  el('revert-prompt').disabled = !dirty && !item.edited && !item.backdrop

  renderReader(item)

  const menu = state.queue.backdrops ?? []
  const row = el('backdrop-row')
  row.classList.toggle('hidden', !menu.length)
  el('backdrop-note').textContent = item.writtenBy
    ? `written by ${readerLabel(item.writtenBy)}`
    : item.edited
      ? 'prompt rewritten by hand'
      : ''
  if (!menu.length) return

  const select = el('backdrop')
  const signature = `${menu.length}:${menu[0].id}`
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature
    select.innerHTML = `<option value="">As queued</option>${menu
      .map((entry) => `<option value="${escapeAttribute(entry.id)}">${escapeHtml(entry.label)}</option>`)
      .join('')}`
  }
  select.value = item.backdrop ?? ''

  renderColour(item, menu)
}

/**
 * The colour the surface is asked for in.
 *
 * Only a surface with a material underneath it can be recoloured — "matte
 * black" and the model's own choice are colours already, and there is nothing
 * left to tint — so the menu says so rather than offering a choice that fails.
 */
function renderColour(item, menu) {
  const colours = state.queue.templates?.colours ?? []
  const select = el('colour')
  const note = el('colour-note')
  const chosen = menu.find((entry) => entry.id === item.backdrop)
  const colourable = Boolean(chosen?.material)

  if (select.dataset.count !== String(colours.length)) {
    select.dataset.count = String(colours.length)
    select.innerHTML = `<option value="">As it comes</option>${colours
      .map((entry) => `<option value="${escapeAttribute(entry.id)}">${escapeHtml(entry.label)}</option>`)
      .join('')}`
  }
  select.value = item.colour ?? ''
  select.disabled = !colours.length || !colourable
  renderEffects(item)
  note.textContent = !colours.length
    ? 'reload Combo Maker to enable'
    : item.backdrop && !colourable
      ? 'this surface is already a colour'
      : !item.backdrop
        ? 'pick a backdrop first'
        : ''
}

/** The model picker and its button, which only work with an OpenRouter key. */
function renderReader(item) {
  const select = el('reader')
  const button = el('recreate')
  const note = el('reader-note')
  const models = state.readers?.models ?? []

  if (!models.length) {
    select.classList.add('hidden')
    button.disabled = true
    button.textContent = 'Rewriting needs Combo Maker running'
    note.textContent = ''
    return
  }
  select.classList.remove('hidden')

  if (select.dataset.count !== String(models.length)) {
    select.dataset.count = String(models.length)
    select.innerHTML = models
      .map((entry) => `<option value="${escapeAttribute(entry.id)}">${escapeHtml(entry.label)}</option>`)
      .join('')
  }
  select.value = state.reader ?? models[0].id
  select.disabled = state.recreating

  const ready = Boolean(state.readers.ready)
  button.disabled = !ready || state.recreating || !item.references?.length
  button.textContent = state.recreating ? 'Reading the picture...' : 'Let this model write the prompt'
  note.textContent = ready ? '' : 'needs an OpenRouter key'
}

/** Atmosphere, as ticks — independent of the surface, so always available. */
function renderEffects(item) {
  const effects = state.queue.templates?.effects ?? []
  const box = el('effects')
  if (box.dataset.count !== String(effects.length)) {
    box.dataset.count = String(effects.length)
    box.innerHTML = effects
      .map((effect) => `<label><input type="checkbox" data-effect="${escapeAttribute(effect.id)}">${escapeHtml(effect.label)}</label>`)
      .join('')
  }
  const on = new Set(item.effects ?? [])
  for (const input of box.querySelectorAll('input[data-effect]')) {
    input.checked = on.has(input.dataset.effect)
  }
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])

const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;')

function render() {
  const offline = !state.base
  const empty = Boolean(state.base) && !state.queue
  el('offline').classList.toggle('hidden', !offline)
  el('empty').classList.toggle('hidden', !empty)
  el('work').classList.toggle('hidden', offline || empty)
  if (offline || empty) return

  const items = state.queue.items
  const done = items.filter((item) => item.status === 'done').length
  const skipped = items.filter((item) => item.status === 'skipped').length
  el('bar').style.width = `${items.length ? ((done + skipped) / items.length) * 100 : 0}%`
  el('counts').textContent = `${done} done${skipped ? ` · ${skipped} skipped` : ''} of ${items.length}`
  el('only-pending').textContent = state.onlyPending ? 'Showing what is left' : 'Showing all'

  const list = visible()
  const item = current()
  if (!item) {
    el('combo').textContent = state.onlyPending ? 'Everything is done.' : 'Nothing to show.'
    el('position').textContent = ''
    el('references').innerHTML = ''
    el('prompt').value = ''
    el('angle').textContent = ''
    el('saveas').textContent = ''
    el('backdrop-row').classList.add('hidden')
    el('save-prompt').disabled = true
    el('revert-prompt').disabled = true
    el('recreate').disabled = true
    return
  }

  el('combo').textContent = item.combo
  el('position').textContent = `${state.index + 1} / ${list.length}`
  el('angle').textContent = item.angle
  renderPrompt(item)
  el('saveas').textContent = item.saveAs
  el('references').innerHTML = (item.references ?? [])
    .map((reference) => `<img src="${referenceUrl(reference)}" alt="" loading="lazy">`)
    .join('')

  const STATE_TEXT = { pending: 'Not done yet', done: 'Done ✓', skipped: 'Skipped' }
  el('state').textContent = STATE_TEXT[item.status]
  el('state').className = `state ${item.status}`
  // Undo only means something once the item has actually been marked.
  el('undo').classList.toggle('hidden', item.status === 'pending')

  el('done').textContent = item.status === 'done' ? 'Done ✓' : 'Done →'
  el('prev').disabled = state.index === 0
}

/**
 * Keyboard shortcuts, so the loop is press-a-key then Cmd/Ctrl+V in the page
 * rather than aiming at a button between every paste.
 *
 * Nothing fires while a text field has focus — the prompt box is selectable,
 * and typing a port number should not mark anything done.
 */
const SHORTCUTS = {
  i: copyImage,
  c: copyPrompt,
  s: saveImage,
  r: recreatePrompt,
  f: () => {
    const first = el('effects').querySelector('input[data-effect]')
    if (first) toggleEffect(first.dataset.effect, !first.checked)
  },
  e: () => {
    const box = el('prompt')
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  },
  d: () => mark('done'),
  k: () => mark('skipped'),
  u: () => { if (current()?.status !== 'pending') mark('pending', false) },
  arrowleft: () => step(-1),
  arrowright: () => step(1),
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const action = SHORTCUTS[event.key.toLowerCase()]
  if (!action) return
  event.preventDefault()
  action()
})

/* ---------------- wiring ---------------- */

el('refresh').addEventListener('click', () => {
  say('Reloading...')
  connect()
})
el('copy-prompt').addEventListener('click', copyPrompt)
el('prompt').addEventListener('input', (event) => {
  const item = current()
  if (!item) return
  state.drafts.set(item.id, event.target.value)
  renderPrompt(item)
})
// Escape is how you get back to the single-key shortcuts; the draft is kept.
el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') el('prompt').blur()
})
el('save-prompt').addEventListener('click', () => savePrompt())
el('revert-prompt').addEventListener('click', revertPrompt)
el('recreate').addEventListener('click', recreatePrompt)
el('reader').addEventListener('change', (event) => {
  state.reader = event.target.value
  chrome.storage.local.set({ reader: state.reader })
  say(`${readerLabel(state.reader)} will write the next rewrite.`)
})
el('backdrop').addEventListener('change', (event) => {
  if (event.target.value) {
    // A new surface starts from its own colour; the old tint is not carried on.
    chooseBackdrop(event.target.value, '')
    return
  }
  // "As queued" is the same thing Revert does — put the original prompt back.
  revertPrompt()
})
el('effects').addEventListener('change', (event) => {
  const input = event.target.closest('input[data-effect]')
  if (input) toggleEffect(input.dataset.effect, input.checked)
})
el('colour').addEventListener('change', (event) => {
  chooseBackdrop(el('backdrop').value, event.target.value)
})
el('copy-image').addEventListener('click', copyImage)
el('save-image').addEventListener('click', saveImage)
el('done').addEventListener('click', () => mark('done'))
el('skip').addEventListener('click', () => mark('skipped'))
el('undo').addEventListener('click', () => mark('pending', false))
el('prev').addEventListener('click', () => step(-1))
el('only-pending').addEventListener('click', () => {
  state.onlyPending = !state.onlyPending
  state.index = 0
  render()
})
el('open-folder').addEventListener('click', async () => {
  try {
    await callApi('/api/ai/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.queue.directory }),
    })
  } catch (error) {
    say(error.message, true)
  }
})
el('reset').addEventListener('click', async () => {
  if (!confirm(`Put all ${state.queue.items.length} items back to not-done?`)) return
  try {
    state.queue = await callApi('/api/queue/reset', { method: 'POST' })
    state.index = 0
    render()
    say('Progress reset.')
  } catch (error) {
    say(error.message, true)
  }
})
el('clear').addEventListener('click', async () => {
  const total = state.queue.items.length
  if (!confirm(`Clear this queue of ${total} items from the extension?\n\nThe folder on disk — reference images and prompts.txt — is kept.`)) return
  try {
    await callApi('/api/queue/clear', { method: 'POST' })
    state.queue = null
    state.index = 0
    render()
    say('Queue cleared. The folder on disk was kept.')
  } catch (error) {
    say(error.message, true)
  }
})

el('port').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ port: Number(event.target.value) })
  connect()
})

chrome.storage.local.get('port').then(({ port }) => {
  if (port) el('port').value = port
})
connect()
